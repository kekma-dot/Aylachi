export const EXECUTION_EVENT_KIND = 'execution.event';
export const EXECUTION_SCHEMA_VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:/|-]{0,255}$/;
const TYPES = new Set([
  'turn.started', 'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.needs_reconciliation',
  'item.started', 'item.completed', 'tool.started', 'tool.completed', 'tool.effect', 'artifact.version', 'theme.proposal', 'text.delta', 'reasoning.delta', 'turn.metrics',
]);
const WORKER_TYPES = new Set(['tool.started', 'tool.completed', 'text.delta', 'turn.metrics']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validId = value => typeof value === 'string' && ID.test(value);
const validItemId = value => typeof value === 'string' && ITEM_ID.test(value);
function exact(value, keys) {
  if (!object(value)) throw new TypeError('INVALID_EXECUTION_EVENT');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every(key => own.includes(key))) throw new TypeError('INVALID_EXECUTION_EVENT');
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('INVALID_EXECUTION_EVENT');
  }
}
function payloadSnapshot(type, value) {
  if (type === 'turn.metrics') {
    const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'durationMs'];
    exact(value, keys);
    if (keys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0) || value.durationMs < 1) throw new TypeError('INVALID_EXECUTION_EVENT');
    return Object.fromEntries(keys.map(key => [key, value[key]]));
  }
  if (type === 'text.delta' || type === 'reasoning.delta') {
    exact(value, ['text']);
    if (typeof value.text !== 'string' || !value.text || Buffer.byteLength(value.text) > 16 * 1024) throw new TypeError('INVALID_EXECUTION_EVENT');
    return { text: value.text };
  }
  if (type === 'tool.started') {
    exact(value, ['toolName']);
    if (typeof value.toolName !== 'string' || !value.toolName || value.toolName.length > 256) throw new TypeError('INVALID_EXECUTION_EVENT');
    return { toolName: value.toolName };
  }
  if (type === 'tool.completed') {
    exact(value, ['toolName', 'isError']);
    if (typeof value.toolName !== 'string' || !value.toolName || value.toolName.length > 256 || typeof value.isError !== 'boolean') throw new TypeError('INVALID_EXECUTION_EVENT');
    return { toolName: value.toolName, isError: value.isError };
  }
  if (type === 'tool.effect') {
    exact(value, ['toolName', 'state', 'attempt', 'payloadHash', 'reasonCode']);
    if (typeof value.toolName !== 'string' || !validId(value.toolName) ||
        !['PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'UNKNOWN', 'SUCCEEDED', 'FAILED'].includes(value.state) ||
        !Number.isSafeInteger(value.attempt) || value.attempt < 1 || typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadHash) ||
        !(value.reasonCode === null || (typeof value.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.reasonCode)))) throw new TypeError('INVALID_EXECUTION_EVENT');
    return { toolName: value.toolName, state: value.state, attempt: value.attempt, payloadHash: value.payloadHash, reasonCode: value.reasonCode };
  }
  if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) throw new TypeError('INVALID_EXECUTION_EVENT');
  return JSON.parse(JSON.stringify(value));
}

// Only the private worker channel may supply this additive event shape. It
// cannot choose workspace/conversation/run identity; the Hub binds those IDs.
export function snapshotWorkerExecutionEvent(value) {
  exact(value, ['type', 'sessionId', 'turnId', 'itemId', 'eventId', 'payload']);
  if (!WORKER_TYPES.has(value.type) || !validId(value.sessionId) || !validId(value.turnId) ||
      !validItemId(value.itemId) || !validItemId(value.eventId)) throw new TypeError('INVALID_EXECUTION_EVENT');
  return Object.freeze({ type: value.type, sessionId: value.sessionId, turnId: value.turnId,
    itemId: value.itemId, eventId: value.eventId, payload: Object.freeze(payloadSnapshot(value.type, value.payload)) });
}

export function makeExecutionEvent({ card, command, type, itemId, eventId, payload = {} }) {
  if (!card || !command || !TYPES.has(type) || !validItemId(itemId) || !validItemId(eventId)) throw new TypeError('INVALID_EXECUTION_EVENT');
  return Object.freeze({ schemaVersion: EXECUTION_SCHEMA_VERSION, workspaceId: card.canvasId, conversationId: card.id,
    runId: command.id, turnId: command.id, itemId, eventId, type, payload: Object.freeze(payloadSnapshot(type, payload)) });
}

export function executionRecord(sequence, event) {
  const durable = sequence !== null;
  if ((durable && (!Number.isSafeInteger(sequence) || sequence < 1)) || (!durable && sequence !== null) ||
      !object(event) || event.schemaVersion !== EXECUTION_SCHEMA_VERSION || !TYPES.has(event.type) ||
      ![event.workspaceId, event.conversationId, event.runId, event.turnId].every(validId) ||
      !validItemId(event.itemId) || !validItemId(event.eventId)) throw new TypeError('INVALID_EXECUTION_EVENT');
  return Object.freeze({ seq: sequence, durable, event });
}
