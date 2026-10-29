const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && ID.test(value);
function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }
function plain(value, keys) {
  if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => own.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function publicEffect(effect) {
  if (!effect) return null;
  return Object.freeze({ id: effect.id, requestId: effect.requestId, parentCommandId: effect.parentCommandId,
    parentCardId: effect.parentCardId, canvasId: effect.canvasId, toolName: effect.toolName,
    payloadHash: effect.payloadHash, attempt: effect.attempt, state: effect.state,
    reasonCode: effect.reasonCode, receipt: effect.receipt });
}

// Additive checkpoint/approval boundary around the existing delegation module.
// The wrapped module remains the sole owner of child create/send/reconciliation.
export function createDelegationEffectRoutes({ routes, effects, resolveParent, approve, requireApproval = () => false, ownerId, now = Date.now, onEffect = () => {} } = {}) {
  if (!Array.isArray(routes) || !effects || typeof resolveParent !== 'function' || typeof approve !== 'function' ||
      typeof requireApproval !== 'function' || !validId(ownerId) || typeof now !== 'function' || typeof onEffect !== 'function') throw new TypeError('effect routes require trusted delegation dependencies');
  const postRoute = routes.find(route => route.method === 'POST' && route.path === '/v1/modules/delegation');
  const readRequestRoute = routes.find(route => route.method === 'GET' && route.path === '/v1/modules/delegation');
  if (!postRoute || !readRequestRoute) throw new TypeError('delegation routes required');
  for (const name of ['reserve', 'get', 'findRequest', 'approve', 'begin', 'complete', 'markUnknown', 'reconcile', 'recoverRunning']) {
    if (typeof effects[name] !== 'function') throw new TypeError('tool effect store required');
  }
  function emit(effect) { onEffect(publicEffect(effect)); }
  function contextFor(actor, parentCommandId, action) {
    const context = resolveParent({ actor, parentCommandId, action });
    if (!context) throw fail(404, 'not_found');
    return context;
  }
  function checkedBody(actor, body, requestId) {
    if (!validId(actor) || !plain(body, ['parentCommandId', 'requestId', 'text']) || !validId(body.parentCommandId) ||
        !validId(body.requestId) || body.requestId !== requestId || typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text) > 16 * 1024) throw fail(400, 'invalid_request');
    return body;
  }
  async function reconcileUnknown(effect, actor) {
    if (effect.state !== 'UNKNOWN') return effect;
    let response;
    try {
      response = await readRequestRoute.handle({ actor, params: {}, query: { parentCommandId: effect.parentCommandId, requestId: effect.requestId } });
    } catch (error) {
      if (error?.status === 404) return effect;
      throw error;
    }
    if (response.status === 200 && isObject(response.body?.record) && ['DISPATCHED', 'COMPLETED'].includes(response.body.record.state)) {
      const updated = effects.reconcile({ actor, id: effect.id, attempt: effect.attempt, payloadHash: effect.payloadHash, receipt: response.body.record, now: now() });
      emit(updated); return updated;
    }
    return effect;
  }
  async function execute({ actor, body, requestId }) {
    checkedBody(actor, body, requestId);
    let effect = effects.findRequest({ actor, requestId });
    const context = contextFor(actor, body.parentCommandId, effect ? 'read' : 'delegate');
    const reserved = effects.reserve({ actor, requestId, parentCommandId: body.parentCommandId, parentCardId: context.parentCardId,
      canvasId: context.canvasId, toolName: 'delegate_task', text: body.text, requiresApproval: requireApproval(Object.freeze({ context, request: Object.freeze({ requestId, text: body.text }) })) === true, now: now() });
    effect = reserved.effect;
    if (!reserved.duplicate) emit(effect);
    if (effect.parentCommandId !== body.parentCommandId || effect.parentCardId !== context.parentCardId || effect.canvasId !== context.canvasId || effect.text !== body.text) throw fail(409, 'conflict');
    if (effect.state === 'PENDING_APPROVAL') return { status: 202, body: { effect: publicEffect(effect), outcome: 'approval_required' } };
    if (effect.state === 'RUNNING') return { status: 202, body: { effect: publicEffect(effect), outcome: 'running' } };
    if (effect.state === 'UNKNOWN') {
      effect = await reconcileUnknown(effect, actor);
      if (effect.state === 'UNKNOWN') return { status: 202, body: { effect: publicEffect(effect), outcome: 'unknown' } };
    }
    if (effect.state === 'FAILED') throw fail(409, 'effect_failed_retry_blocked');
    if (effect.state === 'SUCCEEDED') return { status: 200, body: { record: effect.receipt, duplicate: true } };
    effect = effects.begin({ actor, id: effect.id, attempt: effect.attempt, payloadHash: effect.payloadHash, ownerId, now: now() }); emit(effect);
    let response;
    try { response = await postRoute.handle({ actor, body, requestId }); }
    catch (error) {
      effect = effects.markUnknown({ actor, id: effect.id, attempt: effect.attempt, ownerId, reasonCode: 'DISPATCH_OUTCOME_UNKNOWN', now: now() }); emit(effect);
      throw error;
    }
    if ((response.status === 200 || response.status === 201) && isObject(response.body?.record) && response.body.outcome !== 'unknown') {
      effect = effects.complete({ actor, id: effect.id, attempt: effect.attempt, ownerId, state: 'SUCCEEDED', receipt: response.body.record, now: now() }); emit(effect);
      return response;
    }
    effect = effects.markUnknown({ actor, id: effect.id, attempt: effect.attempt, ownerId, reasonCode: 'DISPATCH_OUTCOME_UNKNOWN', now: now() }); emit(effect);
    return { status: 202, body: { effect: publicEffect(effect), outcome: 'unknown' } };
  }
  async function readEffect({ actor, params, query }) {
    if (!validId(actor) || !plain(params, ['id']) || !validId(params.id) || !plain(query, [])) throw fail(400, 'invalid_request');
    let effect = effects.get({ actor, id: params.id });
    if (!effect) throw fail(404, 'not_found');
    contextFor(actor, effect.parentCommandId, 'read');
    effect = await reconcileUnknown(effect, actor);
    return { status: 200, body: { effect: publicEffect(effect) } };
  }
  async function approveEffect({ actor, params, body }) {
    if (!validId(actor) || !plain(params, ['id']) || !validId(params.id) || !plain(body, ['parentCommandId', 'attempt', 'payloadHash']) ||
        !validId(body.parentCommandId) || !Number.isSafeInteger(body.attempt) || body.attempt < 1 || typeof body.payloadHash !== 'string' || !HASH.test(body.payloadHash)) throw fail(400, 'invalid_request');
    let effect = effects.get({ actor, id: params.id });
    if (!effect || effect.parentCommandId !== body.parentCommandId) throw fail(404, 'not_found');
    const context = contextFor(actor, effect.parentCommandId, 'approve');
    if (approve(Object.freeze({ action: 'approve', context, request: Object.freeze({ requestId: effect.requestId, text: effect.text }), effect: publicEffect(effect) })) !== true) throw fail(404, 'not_found');
    effect = effects.approve({ actor, id: effect.id, attempt: body.attempt, payloadHash: body.payloadHash, now: now() }); emit(effect);
    return execute({ actor, body: { parentCommandId: effect.parentCommandId, requestId: effect.requestId, text: effect.text }, requestId: effect.requestId });
  }
  const target = postRoute.target;
  return Object.freeze([
    ...routes.map(route => route === postRoute ? Object.freeze({ ...postRoute, handle: execute }) : route),
    Object.freeze({ method: 'GET', path: '/v1/modules/delegation-effects/:id', operation: 'delegation.read', effect: 'read', target, handle: readEffect }),
    Object.freeze({ method: 'POST', path: '/v1/modules/delegation-effects/:id/approval', operation: 'delegation.delegate', effect: 'write', target, handle: approveEffect }),
  ]);
}
