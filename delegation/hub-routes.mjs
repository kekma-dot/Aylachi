import { createDelegationCoordinator } from './coordinator.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TEXT_LIMIT = 16 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const TASK_STATES = new Set(['RESERVED', 'DISPATCHED', 'NEEDS_RECONCILIATION', 'COMPLETED']);
const CONTEXT_KEYS = ['actor', 'parentCommandId', 'parentCardId', 'canvasId'];
const RECORD_KEYS = [
  'id', 'actor', 'requestId', 'parentCommandId', 'parentCardId', 'canvasId', 'text',
  'childCardId', 'childSessionId', 'leaseId', 'childCommandId', 'cancelRequestId',
  'state', 'result', 'createdAt', 'updatedAt',
];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && ID.test(value);
const safeFailures = new WeakSet();
function failure(status, code) {
  const error = Object.assign(new Error(code), { status, code });
  safeFailures.add(error);
  return error;
}
const notFound = () => failure(404, 'not_found');
const internal = () => failure(500, 'internal_error');

function plainData(value, keys) {
  try {
    if (!isObject(value)) return false;
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

function checkedContext(value, actor, parentCommandId) {
  if (!plainData(value, CONTEXT_KEYS) || CONTEXT_KEYS.some(key => !safeId(value[key])) ||
      value.actor !== actor || value.parentCommandId !== parentCommandId) return null;
  return Object.freeze({ actor: value.actor, parentCommandId: value.parentCommandId, parentCardId: value.parentCardId, canvasId: value.canvasId });
}

function resolveContext(resolveParent, actor, parentCommandId, action) {
  if (!safeId(actor) || !safeId(parentCommandId)) throw notFound();
  let value;
  try { value = resolveParent(Object.freeze({ actor, parentCommandId, action })); }
  catch { throw internal(); }
  const context = checkedContext(value, actor, parentCommandId);
  if (!context) throw notFound();
  return context;
}

function sameContext(left, right) {
  return CONTEXT_KEYS.every(key => left[key] === right[key]);
}

function publicResult(state, result) {
  if (state !== 'COMPLETED') {
    if (result !== null) throw internal();
    return null;
  }
  if (!isObject(result)) throw internal();
  const status = Object.getOwnPropertyDescriptor(result, 'status');
  if (!status?.enumerable || !Object.hasOwn(status, 'value')) throw internal();
  if (status.value === 'ok' && plainData(result, ['status', 'text']) && typeof result.text === 'string' && Buffer.byteLength(result.text, 'utf8') <= TEXT_LIMIT) {
    return Object.freeze({ status: 'ok', text: result.text });
  }
  if (status.value === 'cancelled' && plainData(result, ['status'])) return Object.freeze({ status: 'cancelled' });
  if (status.value === 'error' && plainData(result, ['status', 'code']) && typeof result.code === 'string' && CODE.test(result.code)) {
    return Object.freeze({ status: 'error', code: result.code });
  }
  throw internal();
}

function publicRecord(record, actor, context) {
  if (!plainData(record, RECORD_KEYS) || CONTEXT_KEYS.some(key => record[key] !== context[key]) || record.actor !== actor ||
      !safeId(record.id) || !safeId(record.requestId) || !safeId(record.childCardId) || !safeId(record.childSessionId) ||
      !safeId(record.leaseId) || !safeId(record.childCommandId) || !safeId(record.cancelRequestId) ||
      typeof record.text !== 'string' || !record.text.trim() || Buffer.byteLength(record.text, 'utf8') > TEXT_LIMIT ||
      !TASK_STATES.has(record.state) || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt) ||
      record.createdAt < 0 || record.updatedAt < record.createdAt) throw internal();
  const result = publicResult(record.state, record.result);
  return Object.freeze({
    id: record.id,
    requestId: record.requestId,
    parentCommandId: record.parentCommandId,
    parentCardId: record.parentCardId,
    canvasId: record.canvasId,
    childCardId: record.childCardId,
    childSessionId: record.childSessionId,
    childCommandId: record.childCommandId,
    state: record.state,
    result,
  });
}

function response(status, body) {
  let serialized;
  try { serialized = JSON.stringify(body); } catch { throw internal(); }
  if (Buffer.byteLength(serialized, 'utf8') > OUTPUT_LIMIT) throw failure(413, 'too_large');
  return Object.freeze({ status, body: Object.freeze(body) });
}

function safeHandle(handler) {
  return async context => {
    try { return await handler(context); }
    catch (error) { throw safeFailures.has(error) ? error : internal(); }
  };
}

function mapError(error) {
  if (error?.status === 400 || error?.code === 'INVALID_INPUT' || error?.code === 'INVALID_REQUEST') return failure(400, 'invalid_request');
  if (error?.status === 413 || error?.code === 'TOO_LARGE') return failure(413, 'too_large');
  if (error?.status === 409 || error?.code === 'CONFLICT' || error?.code === 'WAIT_TIMEOUT' || error?.code === 'ABORTED') return failure(409, 'conflict');
  if (error?.status === 404 || ['NOT_FOUND', 'POLICY_DENIED', 'PARENT_CONTEXT_INVALID'].includes(error?.code)) return notFound();
  return internal();
}

function recordForActor(store, actor, id, context) {
  let record;
  try { record = store.get({ actor, id }); } catch { throw internal(); }
  if (!record) throw notFound();
  if (!plainData(record, RECORD_KEYS) || record.id !== id) throw internal();
  publicRecord(record, actor, context);
  return record;
}

export function createDelegationModule({ store, hubClient, projectId, resolveParent, approve, pollIntervalMs, waitTimeoutMs, now = Date.now } = {}) {
  for (const name of ['reserve', 'get', 'findRequest', 'transition', 'close']) {
    if (typeof store?.[name] !== 'function') throw new TypeError('delegation store required');
  }
  for (const name of ['createCard', 'sendMessage', 'readCommand', 'cancelCommand']) {
    if (typeof hubClient?.[name] !== 'function') throw new TypeError('Hub client required');
  }
  if (!safeId(projectId) || typeof resolveParent !== 'function' || typeof approve !== 'function' || typeof now !== 'function') {
    throw new TypeError('trusted project and policy hooks required');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000 ||
      !Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 600_000) {
    throw new TypeError('explicit bounded delegation timings required');
  }

  const target = Object.freeze({ projectId });

  function approveCurrent(action, context, { request, record } = {}) {
    const fresh = resolveContext(resolveParent, context.actor, context.parentCommandId, action);
    if (!sameContext(fresh, context)) return false;
    const snapshot = record === undefined ? undefined : Object.freeze({ ...record, result: isObject(record.result) ? Object.freeze({ ...record.result }) : record.result });
    return approve(Object.freeze({ action, context: fresh, ...(request === undefined ? {} : { request }), ...(snapshot === undefined ? {} : { record: snapshot }) })) === true;
  }

  function coordinator(context, request) {
    let boundaryFailure;
    function approveMutation() {
      try {
        if (!request) throw internal();
        let record;
        try { record = store.findRequest({ actor: context.actor, requestId: request.requestId }); }
        catch { throw internal(); }
        if (!record) throw notFound();
        if (!plainData(record, RECORD_KEYS)) throw internal();
        requireOwnedParent(record, context.actor, context);
        if (record.requestId !== request.requestId || record.text !== request.text) throw internal();
        publicRecord(record, context.actor, context);
        requireApproval('delegate', context, { request, record });
      } catch (error) {
        boundaryFailure = safeFailures.has(error) ? error : internal();
        throw boundaryFailure;
      }
    }
    const guardedHubClient = {
      createCard(...args) { approveMutation(); return hubClient.createCard(...args); },
      sendMessage(...args) { approveMutation(); return hubClient.sendMessage(...args); },
      readCommand(...args) { return hubClient.readCommand(...args); },
      cancelCommand(...args) { return hubClient.cancelCommand(...args); },
    };
    const value = createDelegationCoordinator({
      store,
      hubClient: guardedHubClient,
      getParentContext: () => context,
      approve: ({ action, parent, request, record }) => approveCurrent(action === 'reconcile' ? 'read' : action, parent, { request, record }),
      pollIntervalMs,
      waitTimeoutMs,
      now,
    });
    return Object.freeze({ value, boundaryFailure: () => boundaryFailure });
  }

  function requireApproval(action, context, details) {
    if (!approveCurrent(action, context, details)) throw notFound();
  }

  function requireOwnedParent(record, actor, context) {
    if (!record || record.actor !== actor || record.parentCommandId !== context.parentCommandId ||
        record.parentCardId !== context.parentCardId || record.canvasId !== context.canvasId) throw notFound();
  }

  async function post({ actor, body, requestId }) {
    if (!safeId(actor) || !plainData(body, ['parentCommandId', 'requestId', 'text']) ||
        !safeId(body.parentCommandId) || !safeId(body.requestId) || body.requestId !== requestId ||
        typeof body.text !== 'string' || !body.text.trim()) throw failure(400, 'invalid_request');
    if (Buffer.byteLength(body.text, 'utf8') > TEXT_LIMIT) throw failure(413, 'too_large');
    const context = resolveContext(resolveParent, actor, body.parentCommandId, 'delegate');
    const request = Object.freeze({ requestId: body.requestId, text: body.text });
    const invocation = coordinator(context, request);
    let outcome;
    try { outcome = await invocation.value.delegate(request); }
    catch (error) {
      if (invocation.boundaryFailure()) throw invocation.boundaryFailure();
      if (error?.code === 'DELEGATE_OUTCOME_UNKNOWN' && error.record) {
        const claimed = publicRecord(error.record, actor, context);
        const stored = recordForActor(store, actor, claimed.id, context);
        requireOwnedParent(stored, actor, context);
        if (stored.requestId !== body.requestId || stored.text !== body.text) throw internal();
        requireApproval('delegate', context, { request: Object.freeze({ requestId: body.requestId, text: body.text }), record: stored });
        return response(200, { record: publicRecord(stored, actor, context), duplicate: false, outcome: 'unknown' });
      }
      throw mapError(error);
    }
    if (!plainData(outcome, ['record', 'duplicate']) || typeof outcome.duplicate !== 'boolean' || !isObject(outcome.record)) throw internal();
    const claimed = publicRecord(outcome.record, actor, context);
    const stored = recordForActor(store, actor, claimed.id, context);
    requireOwnedParent(stored, actor, context);
    if (stored.requestId !== body.requestId || stored.text !== body.text) throw internal();
    requireApproval('delegate', context, { request: Object.freeze({ requestId: body.requestId, text: body.text }), record: stored });
    return response(outcome.duplicate ? 200 : 201, { record: publicRecord(stored, actor, context), duplicate: outcome.duplicate });
  }

  async function readById({ actor, params, query }) {
    if (!safeId(actor) || !plainData(params, ['id']) || !plainData(query, [])) throw failure(400, 'invalid_request');
    const id = params.id;
    if (!safeId(id)) throw failure(400, 'invalid_request');
    const initial = store.get({ actor, id });
    if (!initial) throw notFound();
    if (!plainData(initial, RECORD_KEYS)) throw internal();
    if (initial.id !== id) throw notFound();
    const context = resolveContext(resolveParent, actor, initial.parentCommandId, 'read');
    requireOwnedParent(initial, actor, context);
    publicRecord(initial, actor, context);
    requireApproval('read', context, { request: Object.freeze({ id }), record: initial });
    let record;
    try { record = await coordinator(context).value.reconcile(id); }
    catch (error) { throw mapError(error); }
    const safeRecord = publicRecord(record, actor, context);
    requireOwnedParent(record, actor, context);
    requireApproval('read', context, { request: Object.freeze({ id }), record });
    return response(200, { record: safeRecord });
  }

  async function readByRequest({ actor, params, query }) {
    if (!safeId(actor) || !plainData(params, []) || !plainData(query, ['parentCommandId', 'requestId']) ||
        !safeId(query.parentCommandId) || !safeId(query.requestId)) throw failure(400, 'invalid_request');
    let initial;
    try { initial = store.findRequest({ actor, requestId: query.requestId }); } catch { throw internal(); }
    if (!initial) throw notFound();
    if (!plainData(initial, RECORD_KEYS)) throw internal();
    if (initial.requestId !== query.requestId || initial.parentCommandId !== query.parentCommandId) throw notFound();
    const context = resolveContext(resolveParent, actor, initial.parentCommandId, 'read');
    requireOwnedParent(initial, actor, context);
    publicRecord(initial, actor, context);
    requireApproval('read', context, { request: Object.freeze({ requestId: query.requestId }), record: initial });
    let record;
    try { record = await coordinator(context).value.reconcile(initial.id); }
    catch (error) { throw mapError(error); }
    const safeRecord = publicRecord(record, actor, context);
    requireOwnedParent(record, actor, context);
    requireApproval('read', context, { request: Object.freeze({ requestId: query.requestId }), record });
    return response(200, { record: safeRecord });
  }

  const routes = [
    { method: 'POST', path: '/v1/modules/delegation', operation: 'delegation.delegate', effect: 'write', target, handle: safeHandle(post) },
    { method: 'GET', path: '/v1/modules/delegation/:id', operation: 'delegation.read', effect: 'read', target, handle: safeHandle(readById) },
    { method: 'GET', path: '/v1/modules/delegation', operation: 'delegation.read', effect: 'read', target, handle: safeHandle(readByRequest) },
  ];
  return Object.freeze(routes.map(route => Object.freeze(route)));
}
