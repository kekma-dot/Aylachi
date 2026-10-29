import { randomBytes } from 'node:crypto';

const MAX_INFLIGHT = 8;
const MAX_MESSAGE_BYTES = 64 * 1024;
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const VALID_TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEADLINES = {
  requestTimeoutMs: 30_000,
  shutdownReplyTimeoutMs: 3_000,
  shutdownGraceMs: 1_000,
  termGraceMs: 750,
  killGraceMs: 1_500,
};
const ALLOWED_DEADLINES = new Set(Object.keys(DEADLINES));

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validId = value => typeof value === 'string' && VALID_ID.test(value);
const sizeOf = value => {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? Buffer.byteLength(json) : Infinity;
  } catch { return Infinity; }
};
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function clientError(code, unknownOutcome = false, childStillOwned = false) {
  const failure = new Error(code);
  failure.code = code;
  failure.unknownOutcome = unknownOutcome;
  if (childStillOwned) failure.childStillOwned = true;
  return failure;
}

function modelContext(value) {
  if (!exactKeys(value, ['provider', 'modelId', 'reasoning']) || !VALID_ID.test(value.provider) || !VALID_ID.test(value.modelId) ||
      !['low', 'medium', 'high'].includes(value.reasoning)) throw 0;
  return Object.freeze({ provider: value.provider, modelId: value.modelId, reasoning: value.reasoning });
}

function turnContext(options) {
  if (options === undefined) return undefined;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) throw 0;
    const keys = Reflect.ownKeys(options);
    if (keys.length < 1 || keys.length > 2 || !keys.includes('turnId') || keys.some(key => !['turnId', 'model'].includes(key))) throw 0;
    const descriptor = Object.getOwnPropertyDescriptor(options, 'turnId');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !VALID_TURN_ID.test(descriptor.value)) throw 0;
    return Object.freeze({ turnId: descriptor.value, ...(Object.hasOwn(options, 'model') ? { model: modelContext(options.model) } : {}) });
  } catch { throw clientError('INVALID_TURN_CONTEXT'); }
}

function outcomeError(verb, childStillOwned = false) {
  const code = verb === 'prompt' ? 'PROMPT_OUTCOME_UNKNOWN'
    : verb === 'cancel' ? 'CANCEL_OUTCOME_UNKNOWN' : 'SHUTDOWN_OUTCOME_UNKNOWN';
  return clientError(code, true, childStillOwned);
}

function validResult(verb, result) {
  if (!isRecord(result)) return false;
  if (verb === 'prompt') {
    const keys = Object.keys(result);
    return (keys.length === 1 && keys[0] === 'text' && typeof result.text === 'string') ||
      (keys.length === 2 && keys.includes('text') && keys.includes('nativeSessionFile') &&
        typeof result.text === 'string' && typeof result.nativeSessionFile === 'string' && result.nativeSessionFile.length > 0);
  }
  if (verb === 'cancel') return exactKeys(result, ['cancelled']) && typeof result.cancelled === 'boolean';
  return exactKeys(result, ['shutdown']) && result.shutdown === true;
}

function validReply(message) {
  if (!isRecord(message) || sizeOf(message) > MAX_MESSAGE_BYTES || !validId(message.id)) return false;
  if (message.ok === true) return exactKeys(message, ['id', 'ok', 'result']);
  return message.ok === false && exactKeys(message, ['id', 'ok', 'error']) &&
    typeof message.error === 'string' && message.error.length <= 512;
}

function deadlineOptions(options) {
  if (!isRecord(options) || Object.keys(options).some(key => !ALLOWED_DEADLINES.has(key))) throw new TypeError('INVALID_CLIENT_OPTIONS');
  const values = { ...DEADLINES, ...options };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new TypeError('INVALID_CLIENT_OPTIONS');
  }
  return values;
}

// Owns the supplied trusted ChildProcess through shutdown/reap; timeout and
// transport failures after send are reported as unknown, never as no-effect.
export function createPiHostClient(child, options = {}, execution = {}) {
  if (!child || typeof child.send !== 'function' || typeof child.on !== 'function' ||
      typeof child.off !== 'function' || typeof child.once !== 'function' || typeof child.kill !== 'function') throw new TypeError('PRIVATE_IPC_CHILD_REQUIRED');
  if (!isRecord(execution) || Object.keys(execution).some(key => key !== 'onExecutionEvent') ||
      (Object.hasOwn(execution, 'onExecutionEvent') && typeof execution.onExecutionEvent !== 'function')) throw new TypeError('INVALID_CLIENT_OPTIONS');
  const onExecutionEvent = execution.onExecutionEvent;
  const deadlines = deadlineOptions(options);
  const prefix = randomBytes(8).toString('hex');
  const pending = new Map();
  let sequence = 0;
  let promptsInFlight = 0;
  let closing = false;
  let transportDead = child.connected === false;
  let exited = child.exitCode != null || child.signalCode != null;
  let shutdownPromise;
  let detached = false;

  function exitedNow() {
    return exited || child.exitCode != null || child.signalCode != null;
  }

  function settle(entry, failure, value) {
    if (pending.get(entry.id) !== entry) return false;
    pending.delete(entry.id);
    clearTimeout(entry.timer);
    if (entry.verb === 'prompt') promptsInFlight--;
    failure ? entry.reject(failure) : entry.resolve(value);
    return true;
  }

  function failPending() {
    for (const entry of [...pending.values()]) settle(entry, outcomeError(entry.verb));
  }

  function breakTransport() {
    if (transportDead) return;
    transportDead = true;
    closing = true;
    failPending();
  }

  function onMessage(message) {
    if (isRecord(message) && message.type === 'execution_event') {
      if (!onExecutionEvent || !exactKeys(message, ['type', 'event']) || sizeOf(message) > MAX_MESSAGE_BYTES) { breakTransport(); return; }
      try { onExecutionEvent(message.event); } catch { breakTransport(); }
      return;
    }
    if (!validReply(message)) { breakTransport(); return; }
    const entry = pending.get(message.id);
    if (!entry) return; // Duplicate or late reply: never replay the request.
    if (message.ok !== true) { settle(entry, outcomeError(entry.verb)); return; }
    if (!validResult(entry.verb, message.result)) { breakTransport(); return; }
    settle(entry, null, message.result);
  }

  function onDisconnect() { breakTransport(); }
  function onError() { breakTransport(); }
  function onExit() { exited = true; breakTransport(); }

  child.on('message', onMessage);
  child.on('disconnect', onDisconnect);
  child.on('error', onError);
  child.on('exit', onExit);

  function sendRequest(verb, sessionId, payload, timeoutMs, internal = false) {
    if (exitedNow()) throw clientError('HOST_EXITED');
    if (transportDead || child.connected === false) throw clientError('HOST_NOT_CONNECTED');
    if (closing && !internal) throw clientError('HOST_CLIENT_CLOSING');
    // ponytail: reserve one slot so cancellation can interrupt eight active prompts.
    const reservedCancel = verb === 'cancel' && promptsInFlight === MAX_INFLIGHT && pending.size === MAX_INFLIGHT;
    if ((verb === 'prompt' && promptsInFlight >= MAX_INFLIGHT) || (pending.size >= MAX_INFLIGHT && !reservedCancel)) throw clientError('INFLIGHT_LIMIT');
    if (sequence >= Number.MAX_SAFE_INTEGER) throw clientError('REQUEST_ID_EXHAUSTED');
    const id = `ipc_${prefix}_${(++sequence).toString(36)}`;
    const message = { id, verb, ...(sessionId === undefined ? {} : { sessionId }), ...(payload === undefined ? {} : { payload }) };
    if (sizeOf(message) > MAX_MESSAGE_BYTES) throw clientError('MESSAGE_TOO_LARGE');

    return new Promise((resolvePromise, rejectPromise) => {
      const entry = { id, verb, resolve: resolvePromise, reject: rejectPromise, timer: undefined };
      pending.set(id, entry);
      if (verb === 'prompt') promptsInFlight++;
      entry.timer = setTimeout(() => settle(entry, outcomeError(verb)), timeoutMs);
      try {
        const accepted = child.send(message, failure => {
          // Even a send callback error can race delivery; never report prompt as no-effect.
          if (failure && pending.get(id) === entry) breakTransport();
        });
        if (accepted === false && pending.get(id) === entry) breakTransport();
      } catch {
        breakTransport();
      }
    });
  }

  function waitForExit(timeoutMs) {
    if (exitedNow()) return Promise.resolve(true);
    return new Promise(resolvePromise => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', onExitWait);
        resolvePromise(value);
      };
      const onExitWait = () => { exited = true; finish(true); };
      const timer = setTimeout(() => finish(exitedNow()), timeoutMs);
      child.once('exit', onExitWait);
      if (exitedNow()) onExitWait();
    });
  }

  function detach() {
    if (detached) return;
    detached = true;
    child.off('message', onMessage);
    child.off('disconnect', onDisconnect);
    child.off('error', onError);
    child.off('exit', onExit);
  }

  async function stopAndReap(acknowledged) {
    if (acknowledged && await waitForExit(deadlines.shutdownGraceMs)) return true;
    if (!exitedNow()) { try { child.kill('SIGTERM'); } catch {} }
    if (await waitForExit(deadlines.termGraceMs)) return true;
    if (!exitedNow()) { try { child.kill('SIGKILL'); } catch {} }
    return waitForExit(deadlines.killGraceMs);
  }

  async function shutdownOwnedChild() {
    let acknowledged = false;
    if (exitedNow()) { detach(); return { shutdown: true }; }
    if (!transportDead && child.connected !== false) {
      try {
        const reply = await sendRequest('shutdown', undefined, undefined, deadlines.shutdownReplyTimeoutMs, true);
        acknowledged = reply.shutdown === true;
      } catch { /* masked; signals and reap still proceed */ }
    }
    const reaped = await stopAndReap(acknowledged);
    if (!reaped) throw clientError('HOST_REAP_TIMEOUT', true, true);
    detach();
    if (!acknowledged) throw outcomeError('shutdown');
    return { shutdown: true };
  }

  function prompt(sessionId, text, options) {
    if (!validId(sessionId)) return Promise.reject(clientError('INVALID_SESSION_ID'));
    if (typeof text !== 'string' || !text.trim()) return Promise.reject(clientError('INVALID_PROMPT'));
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return Promise.reject(clientError('MESSAGE_TOO_LARGE'));
    let context;
    try { context = turnContext(options); }
    catch (failure) { return Promise.reject(failure); }
    const payload = context ? { text, turnId: context.turnId, ...(context.model ? { model: context.model } : {}) } : { text };
    try { return sendRequest('prompt', sessionId, payload, deadlines.requestTimeoutMs); }
    catch (failure) { return Promise.reject(failure); }
  }

  function cancel(sessionId) {
    if (!validId(sessionId)) return Promise.reject(clientError('INVALID_SESSION_ID'));
    try { return sendRequest('cancel', sessionId, undefined, deadlines.requestTimeoutMs).then(result => result.cancelled); }
    catch (failure) { return Promise.reject(failure); }
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    failPending();
    shutdownPromise = shutdownOwnedChild().catch(failure => {
      if (failure.childStillOwned) shutdownPromise = undefined;
      throw failure;
    });
    return shutdownPromise;
  }

  return { prompt, cancel, shutdown };
}
