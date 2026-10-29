import { createHash } from 'node:crypto';
import { createDelegationClient } from '../delegation/client.mjs';
import { createDelegationTool } from '../delegation/tool.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_OPTION_KEYS = new Set(['fetch', 'timeoutMs', 'waitTimeoutMs', 'pollIntervalMs']);

function plainData(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || !keys.every(key => own.includes(key))) return false;
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
  } catch { return false; }
}

function optionSnapshot(options) {
  const keys = Reflect.ownKeys(options);
  if (keys.some(key => typeof key !== 'string' || !CLIENT_OPTION_KEYS.has(key))) throw new TypeError('INVALID_CLIENT_OPTIONS');
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('INVALID_CLIENT_OPTIONS');
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function connectionSnapshot(connection) {
  if (!plainData(connection, ['baseUrl', 'bearer'])) return null;
  const baseUrl = Object.getOwnPropertyDescriptor(connection, 'baseUrl')?.value;
  const bearer = Object.getOwnPropertyDescriptor(connection, 'bearer')?.value;
  if (typeof baseUrl !== 'string' || typeof bearer !== 'string') return null;
  return Object.freeze({ baseUrl, bearer });
}

function captureTurn(getTurnContext, selectedSessionId) {
  let value;
  try { value = getTurnContext(); } catch { return null; }
  try {
    if (!Object.isFrozen(value) || !plainData(value, ['sessionId', 'turnId'])) return null;
    const sessionId = Object.getOwnPropertyDescriptor(value, 'sessionId')?.value;
    const turnId = Object.getOwnPropertyDescriptor(value, 'turnId')?.value;
    if (sessionId !== selectedSessionId || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) ||
        typeof turnId !== 'string' || !TURN_ID.test(turnId)) return null;
    return Object.freeze({ sessionId, turnId });
  } catch { return null; }
}

function requestIdFor(sessionId, turnId, toolCallId) {
  const tuple = JSON.stringify([sessionId, turnId, toolCallId]);
  return `delegation-${createHash('sha256').update(tuple, 'utf8').digest('hex')}`;
}

// Trusted host composition only. `allowSession(sessionId)` must return literal true.
export function createRuntimeDelegationToolFactory({ Type, connection, allowSession, ...boundedClientOptions } = {}) {
  if (!connection || typeof allowSession !== 'function') return () => [];
  const trustedConnection = connectionSnapshot(connection);
  if (!trustedConnection) return () => [];
  const clientOptions = optionSnapshot(boundedClientOptions);

  return function toolDefinitionsFactory(selection) {
    let sessionId, getTurnContext;
    try {
      const session = Object.getOwnPropertyDescriptor(selection, 'sessionId');
      const context = Object.getOwnPropertyDescriptor(selection, 'getTurnContext');
      if (!session?.enumerable || !Object.hasOwn(session, 'value') || !context?.enumerable || !Object.hasOwn(context, 'value')) return [];
      sessionId = session.value;
      getTurnContext = context.value;
    } catch { return []; }
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof getTurnContext !== 'function') return [];
    let allowed = false;
    try { allowed = allowSession(sessionId) === true; } catch { return []; }
    if (!allowed) return [];

    const template = createDelegationTool({
      Type,
      coordinator: { delegate: async () => { throw new Error('UNBOUND'); }, wait: async () => { throw new Error('UNBOUND'); } },
      requestIdForCall: () => { throw new Error('UNBOUND'); },
    });
    const tool = Object.freeze({
      ...template,
      async execute(toolCallId, params, signal) {
        const context = captureTurn(getTurnContext, sessionId);
        if (!context) throw new Error('DELEGATION_BINDING_FAILED');
        const client = createDelegationClient({ ...clientOptions, ...trustedConnection, parentCommandId: context.turnId });
        const delegatedTool = createDelegationTool({
          Type,
          coordinator: client,
          requestIdForCall: callId => requestIdFor(context.sessionId, context.turnId, callId),
        });
        return delegatedTool.execute(toolCallId, params, signal);
      },
    });
    return [tool];
  };
}
