const MAX_INFLIGHT = 8;
const MAX_MESSAGE_BYTES = 64 * 1024;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const validTurnId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const validModel = value => exactDataRecord(value, ['provider', 'modelId', 'reasoning']) && validId(value.provider) && validId(value.modelId) &&
  ['low', 'medium', 'high'].includes(value.reasoning);

function plainDataRecord(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    }
    return true;
  } catch { return false; }
}

function exactDataRecord(value, keys) {
  if (!plainDataRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => ownKeys.includes(key));
}

function byteSize(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Infinity; }
}

// The inherited private child-process channel is the authority boundary. JSON
// fields never grant principals or permissions; callers must authorize before send.
export function attachPiAdapterIpc(adapter, child = process) {
  if (!adapter || typeof adapter.prompt !== 'function' || typeof adapter.cancel !== 'function' || typeof adapter.shutdown !== 'function') throw new TypeError('Pi adapter required');
  if (typeof child.send !== 'function' || typeof child.on !== 'function') throw new TypeError('child IPC process required');
  let closed = false;
  let inflight = 0;
  const activeIds = new Set();
  let shuttingDown;
  const send = (message, callback) => {
    if (!child.connected) { callback?.(new Error('IPC_DISCONNECTED')); return; }
    try { child.send(message, error => { try { callback?.(error); } catch {} }); }
    catch (error) { try { callback?.(error); } catch {} }
  };
  const reply = (id, ok, value, callback) => {
    const response = ok ? { id, ok: true, result: value } : { id, ok: false, error: String(value?.message ?? value).slice(0, 512) };
    if (byteSize(response) > MAX_MESSAGE_BYTES) send({ id, ok: false, error: 'REPLY_TOO_LARGE' }, callback);
    else send(response, callback);
  };
  const shutdown = () => shuttingDown ??= Promise.resolve().then(() => adapter.shutdown());
  async function handle(message) {
    if (closed || !plainDataRecord(message)) return;
    const id = Object.getOwnPropertyDescriptor(message, 'id')?.value;
    const verb = Object.getOwnPropertyDescriptor(message, 'verb')?.value;
    const sessionId = Object.getOwnPropertyDescriptor(message, 'sessionId')?.value;
    const payloadDescriptor = Object.getOwnPropertyDescriptor(message, 'payload');
    const payload = payloadDescriptor?.value;
    if (!validId(id)) return;
    if (activeIds.has(id)) return reply(id, false, 'DUPLICATE_REQUEST_ID');
    activeIds.add(id);
    if (!['prompt', 'cancel', 'shutdown'].includes(verb)) { activeIds.delete(id); return reply(id, false, 'UNKNOWN_VERB'); }
    const expectedMessageKeys = verb === 'prompt' ? ['id', 'verb', 'sessionId', 'payload']
      : verb === 'cancel' ? ['id', 'verb', 'sessionId'] : ['id', 'verb'];
    if (!exactDataRecord(message, expectedMessageKeys)) { activeIds.delete(id); return reply(id, false, 'INVALID_PAYLOAD'); }
    if (verb !== 'shutdown' && !validId(sessionId)) { activeIds.delete(id); return reply(id, false, 'INVALID_SESSION_ID'); }
    const plainPayload = exactDataRecord(payload, ['text']);
    const contextualPayload = exactDataRecord(payload, ['text', 'turnId']);
    const modelPayload = exactDataRecord(payload, ['text', 'turnId', 'model']);
    if (verb === 'prompt' && ((!plainPayload && !contextualPayload && !modelPayload) || typeof payload.text !== 'string' || !payload.text.trim() || Buffer.byteLength(payload.text) > MAX_MESSAGE_BYTES ||
        ((contextualPayload || modelPayload) && !validTurnId(payload.turnId)) || (modelPayload && !validModel(payload.model)))) { activeIds.delete(id); return reply(id, false, 'INVALID_PAYLOAD'); }
    if (verb !== 'prompt' && payload !== undefined) { activeIds.delete(id); return reply(id, false, 'INVALID_PAYLOAD'); }
    if (byteSize(message) > MAX_MESSAGE_BYTES) { activeIds.delete(id); return; }
    if (verb === 'shutdown') {
      closed = true;
      try { await shutdown(); } catch (error) { reply(id, false, error, () => child.disconnect?.()); return; }
      reply(id, true, { shutdown: true }, () => child.disconnect?.());
      return;
    }
    if (verb === 'prompt' && inflight >= MAX_INFLIGHT) { activeIds.delete(id); return reply(id, false, 'INFLIGHT_LIMIT'); }
    if (verb === 'prompt') inflight++;
    try {
      const context = contextualPayload || modelPayload ? Object.freeze({ turnId: payload.turnId, ...(modelPayload ? { model: Object.freeze({ ...payload.model }) } : {}) }) : undefined;
      const result = verb === 'prompt'
        ? context ? await adapter.prompt(sessionId, payload.text, context) : await adapter.prompt(sessionId, payload.text)
        : { cancelled: await adapter.cancel(sessionId) };
      if (byteSize(result) > MAX_MESSAGE_BYTES) reply(id, false, 'REPLY_TOO_LARGE'); else reply(id, true, result);
    } catch (error) { reply(id, false, error); }
    finally { activeIds.delete(id); if (verb === 'prompt') inflight--; }
  }
  const onMessage = message => { void handle(message); };
  const onDisconnect = () => { closed = true; void shutdown().catch(() => {}); };
  child.on('message', onMessage);
  child.on('disconnect', onDisconnect);
  return { shutdown, detach() { closed = true; child.off('message', onMessage); child.off('disconnect', onDisconnect); } };
}
