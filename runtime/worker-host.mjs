import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPiHostClient } from '../agent-host/client.mjs';
import { snapshotModelCatalog } from './model-policy.mjs';
import { snapshotWorkerExecutionEvent } from '../hub/execution-events.mjs';
import { snapshotDelegationBootstrap } from './bootstrap-protocol.mjs';

const STARTUP_TIMEOUT_MS = 15_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'pi-worker.mjs');
const coded = (code, exitCode = 1) => Object.assign(new Error(code), { code, exitCode });
const abortError = signal => { if (signal?.aborted) throw coded('STARTUP_CANCELLED', 1); };

async function sendBootstrap(child, frame) {
  await new Promise((resolvePromise, rejectPromise) => {
    try {
      if (!child.connected || typeof child.send !== 'function' || child.send(frame, failure => failure ? rejectPromise(failure) : resolvePromise()) === false) {
        rejectPromise(new Error('DELEGATION_BOOTSTRAP_SEND_FAILED'));
      }
    } catch (error) { rejectPromise(error); }
  });
}

export async function startWorker(root, sdkRoot, authPath, deadlineMs, signal, {
  spawnChild = spawn, termGraceMs = 2_500, killGraceMs = 2_500, delegationBootstrap, toolsBootstrap, maxSdkCalls, onExecutionEvent,
} = {}) {
  abortError(signal);
  if (![termGraceMs, killGraceMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2_500)) throw coded('INVALID_WORKER_OPTIONS', 64);
  if (toolsBootstrap !== undefined && delegationBootstrap !== undefined) throw coded('TOOLS_BOOTSTRAP_INVALID');
  if (maxSdkCalls !== undefined && (!Number.isInteger(maxSdkCalls) || maxSdkCalls < 1 || maxSdkCalls > 20)) throw coded('LIVE_LIMITS_INVALID', 64);
  if (onExecutionEvent !== undefined && typeof onExecutionEvent !== 'function') throw coded('INVALID_WORKER_OPTIONS', 64);
  const bootstrapFrame = toolsBootstrap !== undefined
    ? (await import('./tools-bootstrap.mjs')).snapshotToolsBootstrap(toolsBootstrap)
    : delegationBootstrap === undefined ? undefined : snapshotDelegationBootstrap(delegationBootstrap);
  const workerEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: join(root, 'pi'),
    XDG_CONFIG_HOME: join(root, 'pi'), XDG_DATA_HOME: join(root, 'pi'),
    AYLACHI_DEV_STATE_ROOT: root, AYLACHI_SDK_ROOT: sdkRoot,
    AYLACHI_DEV_AUTH_PATH: authPath, AYLACHI_DEV_DEADLINE_MS: String(deadlineMs),
  };
  if (maxSdkCalls !== undefined) workerEnv.AYLACHI_DEV_MAX_SDK_CALLS = String(maxSdkCalls);
  if (bootstrapFrame) workerEnv[toolsBootstrap === undefined ? 'AYLACHI_DEV_DELEGATION' : 'AYLACHI_DEV_TOOLS'] = '1';
  const child = spawnChild(process.execPath, [WORKER_PATH], {
    cwd: join(root, 'workspace'),
    env: workerEnv,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  let timer;
  let settled = false;
  let readyModelCatalog;
  let childExited = child.exitCode !== null || child.signalCode !== null;
  let spawnFailed = false;
  const hasExited = () => childExited || child.exitCode !== null || child.signalCode !== null || (spawnFailed && child.pid == null);
  const handshake = new Promise((resolvePromise, rejectPromise) => {
    let bootstrapSent = !bootstrapFrame;
    let readyReceived = false;
    const finish = (error, ready = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('spawn', onSpawn);
      signal?.removeEventListener('abort', onAbort);
      error ? rejectPromise(error) : resolvePromise(ready);
    };
    const onMessage = message => {
      if (message && message.type === 'ready' && (Object.keys(message).length === 1 || (Object.keys(message).length === 2 && Object.hasOwn(message, 'modelCatalog')))) {
        if (Object.hasOwn(message, 'modelCatalog')) {
          try { readyModelCatalog = snapshotModelCatalog(message.modelCatalog); }
          catch { finish(coded('LIVE_WORKER_PROTOCOL_FAILED')); return; }
        }
        if (!bootstrapSent) { readyReceived = true; return; }
        finish(null, true);
      } else if (message && message.type === 'startup_error' && Object.keys(message).length === 2) {
        if (message.code === 'HOST_START_FAILED') finish(coded('LIVE_WORKER_START_FAILED'));
        else if (['SDK_VERSION_UNSUPPORTED', 'SDK_API_UNSUPPORTED', 'SDK_COHORT_UNSUPPORTED'].includes(message.code)) finish(coded(`LIVE_${message.code}`));
        else finish(coded('LIVE_WORKER_PROTOCOL_FAILED'));
      }
      else finish(coded('LIVE_WORKER_PROTOCOL_FAILED'));
    };
    const onSpawn = () => {
      if (!bootstrapFrame || bootstrapSent || settled) return;
      void sendBootstrap(child, bootstrapFrame).then(() => {
        bootstrapSent = true;
        if (readyReceived) finish(null, true);
      }, () => finish(coded('LIVE_WORKER_PROTOCOL_FAILED')));
    };
    const onError = () => { if (child.pid == null) spawnFailed = true; finish(coded('LIVE_WORKER_START_FAILED')); };
    const onExit = () => { childExited = true; finish(coded('LIVE_WORKER_START_FAILED')); };
    const onAbort = () => finish(coded('STARTUP_CANCELLED'));
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    if (bootstrapFrame) child.once('spawn', onSpawn);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(coded('LIVE_WORKER_START_TIMEOUT')), STARTUP_TIMEOUT_MS);
    if (signal?.aborted) onAbort();
  });
  const waitForExit = timeoutMs => {
    if (hasExited()) return Promise.resolve(true);
    return new Promise(resolvePromise => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(exitTimer);
        child.off('exit', onExit);
        child.off('error', onError);
        resolvePromise(value);
      };
      const onExit = () => { childExited = true; finish(true); };
      const onError = () => { if (child.pid == null) { spawnFailed = true; finish(true); } };
      const exitTimer = setTimeout(() => finish(hasExited()), timeoutMs);
      child.once('exit', onExit);
      child.on('error', onError);
      if (hasExited()) finish(true);
    });
  };
  try { await handshake; }
  catch (error) {
    if (!hasExited()) { try { child.kill('SIGTERM'); } catch {} }
    let reaped = await waitForExit(termGraceMs);
    if (!reaped) {
      if (!hasExited()) { try { child.kill('SIGKILL'); } catch {} }
      reaped = await waitForExit(killGraceMs);
    }
    if (!reaped) {
      const failure = coded('LIVE_WORKER_REAP_UNRESOLVED');
      failure.childStillOwned = true;
      failure.ownedChild = child;
      throw failure;
    }
    throw error;
  }
  const host = createPiHostClient(child, { requestTimeoutMs: 30_000, shutdownReplyTimeoutMs: 3_000, shutdownGraceMs: 1_000, termGraceMs: 750, killGraceMs: 1_500 },
    onExecutionEvent ? { onExecutionEvent } : {});
  if (readyModelCatalog) host.modelCatalog = readyModelCatalog;
  return host;
}

export function makeRunner(getHost) {
  const eventSinks = new Map();
  const sessionSinks = new Map();
  const runner = async ({ commandId, card, input, signal, emit = () => {} }) => {
    if (typeof commandId !== 'string' || !ID.test(commandId)) throw Object.assign(coded('INVALID_COMMAND_ID'), { safeNoSideEffect: true });
    const host = getHost();
    if (!host) throw Object.assign(coded('AGENT_NOT_CONFIGURED'), { safeNoSideEffect: true });
    if (signal.aborted) throw Object.assign(coded('CANCELLED_BEFORE_PROMPT'), { safeNoSideEffect: true });
    let cancellation;
    const onAbort = () => {
      try { cancellation = Promise.resolve(host.cancel(card.sessionId)).catch(() => false); }
      catch { cancellation = Promise.resolve(false); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) throw Object.assign(coded('CANCELLED_BEFORE_PROMPT'), { safeNoSideEffect: true });
      const selection = input.model ?? (card.modelProvider === undefined ? host.modelCatalog?.default :
        { provider: card.modelProvider, modelId: card.modelId, reasoning: card.reasoning });
      eventSinks.set(commandId, emit);
      sessionSinks.set(card.sessionId, { commandId, emit });
      const result = await host.prompt(card.sessionId, input.text, { turnId: commandId, ...(selection ? { model: selection } : {}) });
      const keys = Object.keys(result ?? {});
      const valid = (keys.length === 1 && keys[0] === 'text' && typeof result.text === 'string') ||
        (keys.length === 2 && keys.includes('text') && keys.includes('nativeSessionFile') &&
          typeof result.text === 'string' && typeof result.nativeSessionFile === 'string' && result.nativeSessionFile.length > 0);
      if (!valid) throw coded('PROMPT_OUTCOME_UNKNOWN');
      return { text: result.text };
    } catch (error) {
      if (signal.aborted) throw coded('PROMPT_OUTCOME_UNKNOWN');
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      eventSinks.delete(commandId);
      if (sessionSinks.get(card.sessionId)?.commandId === commandId) sessionSinks.delete(card.sessionId);
      if (cancellation) await cancellation;
    }
  };
  runner.onExecutionEvent = event => {
    if (event?.turnId) { eventSinks.get(event.turnId)?.(event); return; }
    const active = sessionSinks.get(event?.sessionId);
    if (!active) return;
    const base = { sessionId: event.sessionId, turnId: active.commandId };
    let raw;
    if (event.type === 'text_delta' && typeof event.text === 'string' && event.text) {
      raw = { ...base, type: 'text.delta', itemId: `${active.commandId}:assistant`, eventId: randomUUID(), payload: { text: event.text } };
    } else if (event.type === 'turn_usage' && event.usage && typeof event.usage === 'object') {
      raw = { ...base, type: 'turn.metrics', itemId: `${active.commandId}:turn`, eventId: `${active.commandId}:metrics:${randomUUID()}`, payload: event.usage };
    } else if (['tool_execution_start', 'tool_execution_end'].includes(event.type) && typeof event.toolCallId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._/|-]{0,127}$/.test(event.toolCallId) && typeof event.toolName === 'string' && event.toolName) {
      const started = event.type === 'tool_execution_start';
      raw = { ...base, type: started ? 'tool.started' : 'tool.completed', itemId: `${active.commandId}:tool:${event.toolCallId}`,
        eventId: `${active.commandId}:${event.toolCallId}:${started ? 'started' : 'completed'}`,
        payload: { toolName: event.toolName, ...(started ? {} : { isError: event.isError === true }) } };
    }
    if (raw) {
      try { active.emit(snapshotWorkerExecutionEvent(raw)); } catch { /* malformed adapter event: drop, never invent identity */ }
    }
  };
  return runner;
}
