import { createExecutionProjection } from './execution-projection.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CARD_COORDINATE = 1_000_000;
const validCoordinate = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_CARD_COORDINATE;
// Read legacy finite positions unchanged; only explicit move writes are bounded.
const validSize = (width, height) => Number.isFinite(width) && width >= 320 && width <= 1200 && Number.isFinite(height) && height >= 360 && height <= 1200;
const validModel = value => value && ID.test(value.provider ?? '') && ID.test(value.modelId ?? '') && ['low', 'medium', 'high'].includes(value.reasoning);
const validStoredModel = card => ID.test(card.modelProvider ?? '') && ID.test(card.modelId ?? '') && ['low', 'medium', 'high'].includes(card.reasoning);
const validReadCard = card => card && Number.isSafeInteger(card.revision) && card.revision >= 1 && Number.isFinite(card.x) && Number.isFinite(card.y) &&
  Object.hasOwn(card, 'width') === Object.hasOwn(card, 'height') && (!Object.hasOwn(card, 'width') || validSize(card.width, card.height)) &&
  (!['modelProvider', 'modelId', 'reasoning'].some(key => Object.hasOwn(card, key)) || ['modelProvider', 'modelId', 'reasoning'].every(key => Object.hasOwn(card, key))) &&
  (!Object.hasOwn(card, 'modelProvider') || validStoredModel(card));
const validPositionCard = card => validReadCard(card) && validCoordinate(card.x) && validCoordinate(card.y);
const safeError = failure => /^[A-Z][A-Z0-9_]{0,63}$/.test(failure?.code ?? '') ? failure.code : 'REQUEST_FAILED';
const failed = message => ({ accepted: false, message });
const invalidCatalog = () => Object.assign(new TypeError('INVALID_SESSION_MAPPING'), { code: 'INVALID_SESSION_MAPPING' });

// UI connection owner only. Disposing a view must never cancel a backend job.
export function createSessionController({ client, cards, newId = () => crypto.randomUUID() }) {
  if (!client || !Array.isArray(cards) || !cards.length || cards.some(card => !ID.test(card.id ?? '') || !ID.test(card.sessionId ?? '')) ||
      new Set(cards.map(card => card.id)).size !== cards.length || new Set(cards.map(card => card.sessionId)).size !== cards.length) throw new TypeError('INVALID_SESSION_MAPPING');
  const makeEntry = card => {
    const entry = { card: { ...card }, records: new Map(), connected: false, error: '', uncertain: null, sending: false, moving: false,
      positionEpoch: 0, positionError: null, positionUncertain: false, positionUnknownRevision: null, stream: null, catchingUp: null };
    const projection = createExecutionProjection({ conversationId: card.id, workspaceId: card.canvasId,
      hasRunning: turnId => entry.records.get(turnId)?.state === 'RUNNING' });
    entry.projection = projection;
    entry.executions = projection.executions;
    entry.pendingExecutions = projection.pendingExecutions;
    Object.defineProperty(entry, 'sequence', { get: () => projection.sequence, set: value => { projection.sequence = value; } });
    return entry;
  };
  function catchUp(entry) {
    if (closed) return Promise.resolve();
    return entry.catchingUp ??= refreshEntry(entry).then(() => { publish(); syncExecutionStream(entry); }).finally(() => { entry.catchingUp = null; });
  }
  function syncExecutionStream(entry) {
    const running = [...entry.records.values()].some(record => record.state === 'RUNNING');
    if (!running || !entry.connected || closed || typeof client.streamEvents !== 'function') {
      entry.stream?.controller.abort(); entry.stream = null; return;
    }
    if (entry.stream) return;
    const stream = { controller: new AbortController() }; entry.stream = stream;
    void client.streamEvents({ cardId: entry.card.id, afterSeq: entry.sequence, signal: stream.controller.signal,
      onReady: seq => { if (seq > entry.sequence) void catchUp(entry); },
      onEvent: record => {
        if (closed || entry.stream !== stream) return;
        const result = entry.projection.accept(record); publish();
        if (result === 'gap') void catchUp(entry);
      },
    }).catch(() => {}).finally(() => { if (entry.stream === stream) entry.stream = null; });
  }
  const entries = cards.map(makeEntry);
  const listeners = new Set();
  const ids = new Set();
  const lifetime = new AbortController();
  let closed = false, refreshPending = null, view;
  function entryFor(input) {
    if (!input || typeof input !== 'object') throw new TypeError('INVALID_SESSION_MAPPING');
    const cardId = input.cardId ?? input.id;
    const entry = entries.find(item => item.card.id === cardId && item.card.sessionId === input.sessionId);
    if (!entry || (input.canvasId !== undefined && input.canvasId !== entry.card.canvasId)) throw new TypeError('INVALID_SESSION_MAPPING');
    return entry;
  }
  function requestId() {
    const value = newId();
    if (typeof value !== 'string' || !ID.test(value) || ids.has(value)) throw new TypeError('INVALID_REQUEST_ID');
    ids.add(value); return value;
  }
  function addCards(catalog) {
    if (!Array.isArray(catalog) || catalog.length < 1 || catalog.length > 100) throw invalidCatalog();
    const cardIds = new Set(), sessionIds = new Set(), existingIds = new Set(), additions = [], validated = [];
    for (let index = 0; index < catalog.length; index++) {
      if (!Object.hasOwn(catalog, index)) throw invalidCatalog();
      const card = catalog[index];
      if (!card || typeof card !== 'object' || Array.isArray(card)) throw invalidCatalog();
      const prototype = Object.getPrototypeOf(card);
      if (prototype !== Object.prototype && prototype !== null) throw invalidCatalog();
      if (typeof card.id !== 'string' || !ID.test(card.id) || typeof card.sessionId !== 'string' || !ID.test(card.sessionId) ||
          typeof card.canvasId !== 'string' || !ID.test(card.canvasId) || !Number.isFinite(card.x) || !Number.isFinite(card.y) ||
          !Number.isSafeInteger(card.revision) || card.revision < 1 || typeof card.title !== 'string' || card.title.length < 1 || card.title.length > 4096 ||
          Object.hasOwn(card, 'width') !== Object.hasOwn(card, 'height') || (Object.hasOwn(card, 'width') && !validSize(card.width, card.height)) ||
          (['modelProvider', 'modelId', 'reasoning'].some(key => Object.hasOwn(card, key)) !== Object.hasOwn(card, 'modelProvider')) ||
          (Object.hasOwn(card, 'modelProvider') && !validStoredModel(card)) || cardIds.has(card.id) || sessionIds.has(card.sessionId)) throw invalidCatalog();
      cardIds.add(card.id); sessionIds.add(card.sessionId);
      validated.push({ ...card });
    }
    for (const card of validated) {
      const existing = entries.find(entry => entry.card.id === card.id);
      if (existing) {
        if (existing.card.sessionId !== card.sessionId || existing.card.canvasId !== card.canvasId) throw invalidCatalog();
        existingIds.add(card.id);
      } else additions.push(card);
    }
    if (existingIds.size !== entries.length || entries.length + additions.length > 100) throw invalidCatalog();
    if (additions.length === 0) return { added: 0 };
    entries.push(...additions.map(makeEntry));
    publish();
    return { added: additions.length };
  }
  function removeCards(keepIds) {
    if (!Array.isArray(keepIds) || keepIds.some(id => typeof id !== 'string' || !ID.test(id))) throw invalidCatalog();
    const keep = new Set(keepIds);
    for (let index = entries.length - 1; index >= 0; index--) {
      if (keep.has(entries[index].card.id)) continue;
      entries[index].stream?.controller.abort();
      entries.splice(index, 1);
    }
    publish();
  }
  function publish() {
    if (closed) return;
    const messagesBySession = {}, metricsBySession = {}, statusBySession = {}, errorBySession = {}, activitiesBySession = {};
    for (const entry of entries) {
      const key = entry.card.sessionId;
      const records = [...entry.records.values()];
      messagesBySession[key] = records.flatMap(record => {
        const messages = record.message ? [{ id: `${record.id}-user`, role: 'user', text: record.message.text, pending: !record.accepted }] : [];
        const result = record.result;
        if (record.accepted === true && record.state === 'COMPLETED' && result?.status === 'ok' && typeof result.text === 'string') {
          messages.push({ id: `${record.id}-assistant`, role: 'assistant', text: result.text,
            ...(record.model ? { model: record.model } : {}), transferSource: { kind: 'command', cardId: entry.card.id, id: record.id } });
        } else {
          const execution = entry.executions.get(record.id);
          const text = execution?.finalText ?? execution?.draft;
          if (typeof text === 'string' && text) messages.push({ id: `${record.id}-assistant`, role: 'assistant', text,
            provisional: !execution.itemFinal, ...(record.model ? { model: record.model } : {}) });
        }
        if (result?.status === 'cancelled') messages.push({ id: `${record.id}-result`, role: 'system', text: 'Cancelled' });
        else if (result?.status === 'error') messages.push({ id: `${record.id}-result`, role: 'system', text: 'Command failed' });
        return messages;
      });
      const unresolved = records.some(record => record.state === 'NEEDS_RECONCILIATION');
      statusBySession[key] = !entry.connected ? 'disconnected' : entry.uncertain || unresolved ? 'reconciliation' : entry.sending || records.some(record => record.state === 'RUNNING') ? 'running' : 'ready';
      errorBySession[key] = entry.error || (unresolved ? 'Backend outcome needs reconciliation; no replay.' : '');
      activitiesBySession[key] = [...entry.executions.values()].flatMap(execution => [...execution.tools.values()]);
      metricsBySession[key] = [...entry.executions.values()].map(execution => execution.metrics).filter(Boolean).at(-1) ?? null;
    }
    view = { cards: entries.map(entry => ({ ...entry.card })), messagesBySession, metricsBySession, statusBySession, errorBySession, activitiesBySession, positionErrorByCard: Object.fromEntries(entries.map(entry => [entry.card.id, entry.positionError])) };
    for (const listener of listeners) listener();
  }
  function merge(entry, command) {
    const previous = entry.records.get(command.id);
    // Delayed GETs and reservation receipts cannot reverse a known terminal result.
    if (previous?.accepted && ['COMPLETED', 'NEEDS_RECONCILIATION'].includes(previous.state) && command.state === 'RUNNING') return;
    entry.records.set(command.id, { ...previous, ...command, accepted: true });
  }
  async function refreshEntry(entry) {
    const positionEpoch = entry.positionEpoch;
    try {
      const snapshot = await client.snapshot(entry.card.id, lifetime.signal);
      if (closed) return;
      if (snapshot.card.id !== entry.card.id || snapshot.card.sessionId !== entry.card.sessionId || snapshot.card.canvasId !== entry.card.canvasId) throw Object.assign(Error(), { code: 'SESSION_MAPPING_CHANGED' });
      let cursor = entry.sequence;
      const idsToRead = new Set([...entry.records.values()].filter(record => record.state === 'RUNNING' || !record.accepted).map(record => record.id));
      // ponytail: at most 1000 events per refresh; page again next tick, add windowed transcripts when histories grow.
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        if (closed) return;
        const page = await client.events(entry.card.id, cursor, 100, lifetime.signal);
        for (const event of page.events) {
          if (event.kind.startsWith('command.') && typeof event.payload?.id === 'string') idsToRead.add(event.payload.id);
          if (event.kind === 'execution.event') entry.projection.accept({ seq: event.sequence, durable: true, event: event.payload });
          else entry.sequence = event.sequence;
        }
        entry.pendingExecutions.clear();
        cursor = page.nextSequence;
        if (page.events.length < 100) break;
      }
      const updates = [];
      for (const id of idsToRead) {
        try { updates.push((await client.readCommand(id, lifetime.signal)).command); }
        catch (failure) {
          if (failure.status === 404 && entry.records.get(id)?.accepted === false) continue;
          throw failure;
        }
      }
      if (closed) return;
      const currentRevision = entry.card.revision;
      if (positionEpoch === entry.positionEpoch && validReadCard(snapshot.card) &&
          (!Number.isSafeInteger(currentRevision) || snapshot.card.revision >= currentRevision)) {
        const advanced = !Number.isSafeInteger(currentRevision) || snapshot.card.revision > currentRevision;
        entry.card = snapshot.card;
        if (advanced && entry.positionError === 'CONFLICT') entry.positionError = null;
        if (entry.positionUncertain) {
          // Fresh state confirms the CAS base; a late request can only win that revision once.
          entry.positionUncertain = false;
          entry.positionUnknownRevision = null;
        }
      }
      for (const command of updates) merge(entry, command);
      entry.sequence = cursor; entry.connected = cursor >= snapshot.eventSequence;
      if (entry.connected && entry.positionError === 'DISCONNECTED') entry.positionError = null;
      entry.error = !entry.connected ? 'SYNCHRONIZING_HISTORY' : entry.uncertain ? 'Send outcome unknown. Reconcile the same draft; no new request ID.' : '';
    } catch (failure) {
      if (!closed) { entry.connected = false; entry.error = safeError(failure); }
    }
  }
  async function send(input) {
    if (closed) return failed('VIEW_CLOSED');
    const entry = entryFor(input);
    if (!entry.connected) return failed('DISCONNECTED');
    if (entry.sending) return failed('SESSION_BUSY');
    const text = input.text;
    let id = entry.uncertain;
    if (id) {
      if (entry.records.get(id)?.message?.text !== text) return failed('RECONCILE_ORIGINAL_DRAFT');
    } else {
      if ([...entry.records.values()].some(record => ['RUNNING', 'NEEDS_RECONCILIATION'].includes(record.state))) return failed('SESSION_BUSY_OR_UNCERTAIN');
      id = requestId();
      entry.records.set(id, { id, state: 'UNKNOWN', result: null, accepted: false, message: { role: 'user', text } });
    }
    entry.sending = true; entry.error = ''; publish();
    try {
      let command;
      if (entry.uncertain) {
        try { command = (await client.readCommand(id, lifetime.signal)).command; }
        catch (failure) { if (failure.status !== 404) throw failure; }
      }
      if (!command) command = (await client.sendMessage(entry.card.id, text, id, lifetime.signal)).command;
      if (closed) return failed('VIEW_CLOSED');
      merge(entry, command); entry.uncertain = null;
      syncExecutionStream(entry);
      return { accepted: true };
    } catch (failure) {
      if (closed) return failed('VIEW_CLOSED');
      if (entry.records.get(id)?.accepted) { entry.uncertain = null; return { accepted: true }; }
      if (entry.uncertain || failure.unknownOutcome) entry.uncertain = id;
      else entry.records.delete(id);
      entry.error = entry.uncertain ? 'Send outcome unknown. Reconcile the same draft; no new request ID.' : safeError(failure);
      return failed(entry.error);
    } finally { entry.sending = false; publish(); }
  }
  function positionFailure(entry, code) {
    entry.positionError = code;
    publish();
    return failed(code);
  }
  async function updateCard(input, operation) {
    if (closed) return failed('VIEW_CLOSED');
    const resize = operation === 'resize', rename = operation === 'rename', model = operation === 'model';
    if (!input || typeof input !== 'object' || typeof input.id !== 'string' || typeof input.canvasId !== 'string' ||
        (input.cardId !== undefined && input.cardId !== input.id)) return failed('INVALID_SESSION_MAPPING');
    let entry;
    try { entry = entryFor({ id: input.id, canvasId: input.canvasId, sessionId: input.sessionId }); }
    catch { return failed('INVALID_SESSION_MAPPING'); }
    if (!entry.connected) return positionFailure(entry, 'DISCONNECTED');
    if (entry.moving) return failed('POSITION_BUSY');
    const method = rename ? 'renameCard' : model ? 'updateModelSettings' : resize ? 'updateLayout' : 'moveCard';
    if (typeof client[method] !== 'function') return positionFailure(entry, rename ? 'RENAME_UNAVAILABLE' : model ? 'MODEL_SETTINGS_UNAVAILABLE' : resize ? 'RESIZE_UNAVAILABLE' : 'MOVE_UNAVAILABLE');
    if (entry.positionUncertain) return failed('POSITION_OUTCOME_UNKNOWN');
    if ((!rename && !model && (!validCoordinate(input.x) || !validCoordinate(input.y))) || (resize && !validSize(input.width, input.height)) ||
        (rename && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120)) || (model && !validModel(input))) {
      return positionFailure(entry, rename ? 'INVALID_TITLE' : model ? 'INVALID_MODEL_SETTINGS' : resize ? 'INVALID_LAYOUT' : 'INVALID_POSITION');
    }
    if (!Number.isSafeInteger(entry.card.revision) || entry.card.revision < 1 || !Number.isSafeInteger(input.revision) || input.revision < 1) return positionFailure(entry, 'INVALID_POSITION');
    if (input.revision !== entry.card.revision) return positionFailure(entry, 'STALE_POSITION');

    const expectedRevision = entry.card.revision;
    entry.moving = true;
    entry.positionEpoch++;
    try {
      const result = await client[method](entry.card.id,
        rename ? { expectedRevision, title: input.title } : model ? { expectedRevision, provider: input.provider, modelId: input.modelId, reasoning: input.reasoning } :
          resize ? { expectedRevision, x: input.x, y: input.y, width: input.width, height: input.height } : { expectedRevision, x: input.x, y: input.y }, lifetime.signal);
      if (closed) return failed('VIEW_CLOSED');
      const moved = result?.card;
      if (!validPositionCard(moved) || moved.id !== entry.card.id || moved.canvasId !== entry.card.canvasId ||
          moved.sessionId !== entry.card.sessionId || moved.revision <= expectedRevision ||
          (resize && (moved.width !== input.width || moved.height !== input.height)) || (rename && moved.title !== input.title) ||
          (model && (moved.modelProvider !== input.provider || moved.modelId !== input.modelId || moved.reasoning !== input.reasoning))) {
        entry.positionError = 'OUTCOME_UNKNOWN';
        entry.positionUncertain = entry.card.revision <= expectedRevision;
        entry.positionUnknownRevision = entry.positionUncertain ? expectedRevision : null;
        publish();
        return failed('OUTCOME_UNKNOWN');
      }
      if (!Number.isSafeInteger(entry.card.revision) || moved.revision >= entry.card.revision) entry.card = { ...entry.card, ...moved };
      entry.positionError = null;
      entry.positionUncertain = false;
      entry.positionUnknownRevision = null;
      publish();
      return { accepted: true };
    } catch (failure) {
      if (closed) return failed('VIEW_CLOSED');
      if (failure.status === 409) {
        entry.positionError = 'CONFLICT';
        entry.positionUncertain = false;
        entry.positionUnknownRevision = null;
      } else if (failure.unknownOutcome) {
        entry.positionError = 'OUTCOME_UNKNOWN';
        entry.positionUncertain = !Number.isSafeInteger(entry.card.revision) || entry.card.revision <= expectedRevision;
        entry.positionUnknownRevision = entry.positionUncertain ? expectedRevision : null;
      } else entry.positionError = safeError(failure);
      publish();
      return failed(entry.positionError);
    } finally {
      entry.moving = false;
      publish();
    }
  }
  function move(input) { return updateCard(input, 'move'); }
  function resize(input) { return updateCard(input, 'resize'); }
  function rename(input) { return updateCard(input, 'rename'); }
  function updateModel(input) { return updateCard(input, 'model'); }
  async function approveEffect(input) {
    if (closed) return failed('VIEW_CLOSED');
    const entry = entryFor(input);
    const activity = entry.executions.get(input.turnId)?.tools.get(input.effectId);
    if (!activity || activity.status !== 'approval' || activity.attempt !== input.expectedAttempt || activity.payloadHash !== input.payloadHash) return failed('EFFECT_CONFLICT');
    try {
      await client.moduleRequest({ method: 'POST', path: `/v1/modules/delegation-effects/${encodeURIComponent(input.effectId)}/approval`,
        body: { parentCommandId: input.turnId, attempt: input.expectedAttempt, payloadHash: input.payloadHash }, signal: lifetime.signal });
      await refreshEntry(entry);
      return { accepted: true };
    } catch (failure) { if (!closed) entry.error = safeError(failure); return failed(safeError(failure)); }
    finally { publish(); }
  }
  async function cancel(input) {
    if (closed) return false;
    const entry = entryFor(input);
    const active = [...entry.records.values()].find(record => record.state === 'RUNNING');
    if (!active || !entry.connected) return false;
    try {
      await client.cancelCommand(active.id, requestId(), lifetime.signal);
      // Cancellation request acceptance does not prove cancellation of the target.
      await refreshEntry(entry);
      return true;
    } catch (failure) { if (!closed) entry.error = safeError(failure); return false; }
    finally { publish(); }
  }
  publish();
  return {
    getSnapshot: () => view,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh() {
      if (closed) return Promise.resolve();
      return refreshPending ??= Promise.all(entries.map(refreshEntry)).then(() => { publish(); entries.forEach(syncExecutionStream); }).finally(() => { refreshPending = null; });
    },
    send, cancel, move, resize, rename, updateModel, approveEffect, addCards, removeCards,
    dispose() { closed = true; lifetime.abort(); for (const entry of entries) entry.stream?.controller.abort(); listeners.clear(); },
  };
}
