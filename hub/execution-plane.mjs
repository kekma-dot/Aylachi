import { EXECUTION_EVENT_KIND, executionRecord, makeExecutionEvent, snapshotWorkerExecutionEvent } from './execution-events.mjs';

// Owns run lifecycle and durable/transient event correlation. HTTP auth and
// routing stay outside; Artifact adapters can publish through the same contract.
export function createExecutionPlane({ store, graph, runner }) {
  const active = new Map();
  const executionStreams = new Set();
  const finalItems = new Set();
  const transientExecutions = new Map();
  let closePromise = null;

  function writeExecution(stream, record) {
    if (stream.res.writableEnded) return;
    stream.res.write(`event: execution\ndata: ${JSON.stringify(record)}\n\n`);
  }
  function publishExecution(record) {
    for (const stream of executionStreams) {
      if (stream.cardId !== record.event.conversationId) continue;
      if (stream.replaying) stream.buffer.push(record); else writeExecution(stream, record);
    }
  }
  function appendExecution(command, card, type, itemId, eventId, payload) {
    const event = makeExecutionEvent({ card, command, type, itemId, eventId, payload });
    const stored = typeof store.appendExecutionEvent === 'function'
      ? store.appendExecutionEvent(card.id, event)
      : (store.appendEvent(card.id, EXECUTION_EVENT_KIND, event), { sequence: store.getCardSnapshot(card.id).eventSequence, event });
    const record = executionRecord(stored.sequence, stored.event);
    publishExecution(record);
    return record;
  }
  function ingestWorkerExecution(command, card, input) {
    const snapshot = snapshotWorkerExecutionEvent(input);
    if (snapshot.sessionId !== card.sessionId || snapshot.turnId !== command.id) throw new TypeError('INVALID_EXECUTION_EVENT');
    if (snapshot.type === 'text.delta' && finalItems.has(`${command.id}:${snapshot.itemId}`)) return;
    const event = makeExecutionEvent({ card, command, ...snapshot });
    if (snapshot.type === 'text.delta') {
      const record = executionRecord(null, event);
      // ponytail: replay at most 1024 deltas for a connecting view; clear at final. SSE remains live for later deltas.
      const buffered = transientExecutions.get(command.id) ?? [];
      if (buffered.length < 1024) { buffered.push(record); transientExecutions.set(command.id, buffered); }
      publishExecution(record);
    } else appendExecution(command, card, snapshot.type, snapshot.itemId, snapshot.eventId, snapshot.payload);
  }

  async function runReserved(command, card, controller) {
    const turnItemId = `${command.id}:turn`, assistantItemId = `${command.id}:assistant`;
    try {
      graph?.beginChatRun(command, card);
      appendExecution(command, card, 'turn.started', turnItemId, `${command.id}:turn:started`);
      appendExecution(command, card, 'item.started', assistantItemId, `${command.id}:assistant:started`, { itemType: 'assistant_message' });
      const result = await runner({ commandId: command.id, card, input: command.input, signal: controller.signal,
        emit: event => ingestWorkerExecution(command, card, event) });
      const cancelled = result?.status === 'CANCELLED';
      if (!cancelled && typeof result?.text === 'string') {
        appendExecution(command, card, 'item.completed', assistantItemId, `${command.id}:assistant:completed`,
          { itemType: 'assistant_message', text: result.text });
        finalItems.add(`${command.id}:${assistantItemId}`);
        transientExecutions.delete(command.id);
      }
      appendExecution(command, card, cancelled ? 'turn.cancelled' : 'turn.completed', turnItemId,
        `${command.id}:turn:${cancelled ? 'cancelled' : 'completed'}`);
      const value = cancelled ? { status: 'cancelled' } : { status: 'ok', value: result ?? null };
      store.completeCommand(command.id, value);
      graph?.completeRun(command.id, cancelled ? 'CANCELLED' : 'SUCCEEDED');
    } catch (error) {
      // Runner may mark a failure safe only when it knows no external effect occurred.
      const safeCode = error?.safeNoSideEffect === true && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code ?? '') ? error.code : null;
      try { graph?.completeRun(command.id, safeCode ? 'FAILED' : 'UNKNOWN'); } catch { /* preserve the original command outcome */ }
      try {
        appendExecution(command, card, safeCode ? 'turn.failed' : 'turn.needs_reconciliation', turnItemId,
          `${command.id}:turn:${safeCode ? 'failed' : 'needs_reconciliation'}`, { code: safeCode ?? 'RUN_OUTCOME_UNKNOWN' });
        if (safeCode) store.completeCommand(command.id, { status: 'error', code: safeCode });
        else store.markNeedsReconciliation(command.id, 'RUN_OUTCOME_UNKNOWN');
      } catch { /* preserve RUNNING for store recovery; never replay */ }
    }
  }

  function dispatch(command, card) {
    const controller = new AbortController();
    const job = { controller, promise: null };
    active.set(command.id, job);
    job.promise = runReserved(command, card, controller).finally(() => {
      if (active.get(command.id) === job) active.delete(command.id);
    });
    return job.promise;
  }

  function stream(req, res, cardId, after) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Connection': 'keep-alive',
    });
    const current = { res, cardId, replaying: true, buffer: [], heartbeat: null };
    const cleanup = () => {
      clearInterval(current.heartbeat);
      executionStreams.delete(current);
    };
    executionStreams.add(current);
    req.once('close', cleanup);
    res.once('close', cleanup);
    let cursor = after;
    while (true) {
      const events = store.getCardEvents(cardId, cursor, 100);
      for (const stored of events) {
        cursor = stored.sequence;
        if (stored.kind === EXECUTION_EVENT_KIND) writeExecution(current, executionRecord(stored.sequence, stored.payload));
      }
      if (events.length < 100) break;
    }
    res.write(`event: ready\ndata: ${JSON.stringify({ seq: cursor })}\n\n`);
    for (const records of transientExecutions.values()) for (const record of records) {
      if (record.event.conversationId === cardId && !finalItems.has(`${record.event.turnId}:${record.event.itemId}`)) writeExecution(current, record);
    }
    for (const record of current.buffer.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) writeExecution(current, record);
    current.buffer = [];
    current.replaying = false;
    current.heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 15_000);
  }

  function close() {
    if (closePromise) return closePromise;
    for (const stream of executionStreams) {
      clearInterval(stream.heartbeat);
      stream.res.end();
    }
    executionStreams.clear();
    closePromise = Promise.resolve();
    return closePromise;
  }

  return {
    dispatch,
    wait(commandId) { return active.get(commandId)?.promise ?? Promise.resolve(); },
    stream,
    close,
    abort(commandId) { active.get(commandId)?.controller.abort(); },
    async shutdown({ abortActive = false } = {}) {
      await close();
      const jobs = [...active.values()];
      if (abortActive) for (const job of jobs) job.controller.abort();
      await Promise.allSettled(jobs.map(job => job.promise));
    },
    appendModule(commandId, type, itemId, eventId, payload) {
      const command = store.getCommand(commandId);
      const card = command && store.getCard(command.cardId);
      if (!command || !card) throw new TypeError('INVALID_EXECUTION_TARGET');
      return appendExecution(command, card, type, itemId, eventId, payload);
    },
  };
}
