const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeError = failure => failure?.status === 409 ? 'CONFLICT' : failure?.status === 404 ? 'NOT_FOUND' : failure?.status === 413 ? 'TOO_LARGE' :
  failure?.status === 400 ? 'INVALID_REQUEST' : /^[A-Z][A-Z0-9_]{0,63}$/.test(failure?.code ?? '') ? failure.code : 'REQUEST_FAILED';
const failed = code => Object.assign(new Error(code), { code });

function copySource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw failed('INVALID_REQUEST');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !['cardId', 'kind', 'id', 'revision'].includes(key))) throw failed('INVALID_REQUEST');
  const fields = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw failed('INVALID_REQUEST');
    fields[key] = descriptor.value;
  }
  if (typeof fields.cardId !== 'string' || !SAFE_ID.test(fields.cardId) || typeof fields.id !== 'string' || !SAFE_ID.test(fields.id)) throw failed('INVALID_REQUEST');
  if (fields.kind === 'command' && keys.length === 3 && !Object.hasOwn(fields, 'revision')) {
    return Object.freeze({ cardId: fields.cardId, kind: 'command', id: fields.id });
  }
  if (fields.kind === 'wiki' && keys.length === 4 && typeof fields.revision === 'string' && UUID.test(fields.revision)) {
    return Object.freeze({ cardId: fields.cardId, kind: 'wiki', id: fields.id, revision: fields.revision.toLowerCase() });
  }
  throw failed('INVALID_REQUEST');
}
function freezePending(value) { return Object.freeze(value); }
function sameSource(left, right) {
  return left?.cardId === right?.cardId && left?.kind === right?.kind && left?.id === right?.id && left?.revision === right?.revision;
}
function matches(record, pending) {
  return record?.requestId === pending.requestId && record.targetCardId === pending.targetCardId && sameSource(record.source, pending.source);
}
function upsert(items, record) {
  const index = items.findIndex(item => item.id === record.id);
  if (index < 0) return [record, ...items];
  const next = items.slice(); next[index] = record; return next;
}

export function createHandoffController({ client, newRequestId = () => crypto.randomUUID() } = {}) {
  const methods = ['propose', 'read', 'list', 'accept'];
  if (!client || methods.some(method => typeof client[method] !== 'function') || typeof newRequestId !== 'function') throw new TypeError('INVALID_HANDOFF_CLIENT');

  const listeners = new Set();
  let state = Object.freeze({ items: [], selected: null, busy: false, error: null, uncertain: false, pending: null, targetCardId: null });
  let active = null, generation = 0, disposed = false;
  // ponytail: serialize this controller's reads and writes; parallelize only if the UI needs independent panels.
  function publish(patch) {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  }
  function begin() {
    if (disposed || active) return null;
    const operation = { generation: ++generation, reads: new AbortController(), writes: new AbortController(), mutationStarted: false };
    active = operation;
    publish({ busy: true, error: state.uncertain ? state.error : null });
    return operation;
  }
  const current = operation => !disposed && active === operation && generation === operation.generation;
  function finish(operation) {
    if (!current(operation)) return;
    active = null;
    publish({ busy: false });
  }
  function blocked(code) {
    if (!disposed && !active) publish({ error: code });
    return false;
  }
  function readFailed(operation, failure) {
    if (!current(operation)) return false;
    publish({ error: safeError(failure) });
    return false;
  }
  function mutationFailed(operation, failure, pending, wasUncertain) {
    if (!current(operation)) return false;
    const error = failure?.unknownOutcome === true ? 'OUTCOME_UNKNOWN' : safeError(failure);
    if (wasUncertain) publish({ error, pending, uncertain: true });
    else if (failure?.unknownOutcome === true) publish({ error: 'OUTCOME_UNKNOWN', pending, uncertain: true });
    else publish({ error, pending: null, uncertain: false });
    return false;
  }
  function canMutate() {
    if (state.uncertain || state.pending) return blocked('OUTCOME_UNKNOWN');
    return true;
  }
  function requestId() {
    const value = newRequestId();
    if (typeof value !== 'string' || !SAFE_ID.test(value)) throw failed('INVALID_REQUEST');
    return value;
  }

  async function sendProposal(operation, pending, wasUncertain) {
    operation.mutationStarted = true;
    try {
      const result = await client.propose({ requestId: pending.requestId, source: pending.source, targetCardId: pending.targetCardId, signal: operation.writes.signal });
      if (!current(operation)) return false;
      const record = result.record;
      publish({ items: upsert(state.items, record), selected: record, targetCardId: pending.targetCardId, pending: null, uncertain: false, error: null });
      return true;
    } catch (failure) { return mutationFailed(operation, failure, pending, wasUncertain); }
    finally { finish(operation); }
  }
  async function sendAccept(operation, pending, wasUncertain) {
    operation.mutationStarted = true;
    try {
      const result = await client.accept(pending.id, { requestId: pending.requestId, signal: operation.writes.signal });
      if (!current(operation)) return false;
      const record = result.record;
      publish({ items: upsert(state.items, record), selected: record, targetCardId: record.targetCardId, pending: null, uncertain: false, error: null });
      return true;
    } catch (failure) { return mutationFailed(operation, failure, pending, wasUncertain); }
    finally { finish(operation); }
  }

  async function propose(input = {}) {
    if (active || disposed) return false;
    if (!canMutate()) return false;
    let pending;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw failed('INVALID_REQUEST');
      const { source: sourceInput, targetCardId } = input;
      const source = copySource(sourceInput);
      if (typeof targetCardId !== 'string' || !SAFE_ID.test(targetCardId) || source.cardId === targetCardId) throw failed('INVALID_REQUEST');
      pending = freezePending({ kind: 'propose', requestId: requestId(), source, targetCardId });
    } catch (failure) { return blocked(safeError(failure)); }
    const operation = begin();
    if (!operation) return false;
    publish({ pending });
    return sendProposal(operation, pending, false);
  }

  async function refresh(targetCardId, { limit = 20, offset = 0 } = {}) {
    const operation = begin();
    if (!operation) return false;
    try {
      const result = await client.list(targetCardId, { limit, offset, signal: operation.reads.signal });
      if (!current(operation)) return false;
      publish({ items: result.items, targetCardId, error: state.uncertain ? 'OUTCOME_UNKNOWN' : null });
      return true;
    } catch (failure) { return readFailed(operation, failure); }
    finally { finish(operation); }
  }

  async function open(id) {
    const operation = begin();
    if (!operation) return false;
    try {
      const result = await client.read(id, { signal: operation.reads.signal });
      if (!current(operation)) return false;
      const record = result.record;
      publish({ items: upsert(state.items, record), selected: record, targetCardId: record.targetCardId, error: state.uncertain ? 'OUTCOME_UNKNOWN' : null });
      return true;
    } catch (failure) { return readFailed(operation, failure); }
    finally { finish(operation); }
  }

  async function accept(id) {
    if (active || disposed) return false;
    if (!canMutate()) return false;
    if (typeof id !== 'string' || !UUID.test(id)) return blocked('INVALID_REQUEST');
    let pending;
    try { pending = freezePending({ kind: 'accept', id, requestId: requestId() }); }
    catch (failure) { return blocked(safeError(failure)); }
    const operation = begin();
    if (!operation) return false;
    publish({ pending });
    return sendAccept(operation, pending, false);
  }

  async function reconcile() {
    if (active || disposed) return false;
    const pending = state.pending;
    if (!state.uncertain || !pending) return blocked('NOTHING_TO_RECONCILE');
    const operation = begin();
    if (!operation) return false;
    try {
      if (pending.kind === 'propose') {
        const page = await client.list(pending.targetCardId, { limit: 20, offset: 0, signal: operation.reads.signal });
        if (!current(operation)) return false;
        const match = page.items.find(item => matches(item, pending));
        if (!match) {
          publish({ items: page.items, targetCardId: pending.targetCardId, pending, uncertain: true, error: 'OUTCOME_UNKNOWN' });
          return false;
        }
        const result = await client.read(match.id, { signal: operation.reads.signal });
        if (!current(operation)) return false;
        const record = result.record;
        if (record.id !== match.id || !matches(record, pending)) {
          publish({ items: page.items, targetCardId: pending.targetCardId, pending, uncertain: true, error: 'OUTCOME_UNKNOWN' });
          return false;
        }
        publish({ items: upsert(page.items, record), selected: record, targetCardId: pending.targetCardId, pending: null, uncertain: false, error: null });
        return true;
      }
      const result = await client.read(pending.id, { signal: operation.reads.signal });
      if (!current(operation)) return false;
      const record = result.record;
      if (record.id !== pending.id || record.state !== 'accepted') {
        publish({ items: upsert(state.items, record), selected: record, targetCardId: record.targetCardId, pending, uncertain: true, error: 'OUTCOME_UNKNOWN' });
        return false;
      }
      publish({ items: upsert(state.items, record), selected: record, targetCardId: record.targetCardId, pending: null, uncertain: false, error: null });
      return true;
    } catch (failure) { return readFailed(operation, failure); }
    finally { finish(operation); }
  }

  async function retrySameRequest() {
    if (active || disposed) return false;
    const pending = state.pending;
    if (!state.uncertain || !pending) return blocked('NOTHING_TO_RETRY');
    const operation = begin();
    if (!operation) return false;
    return pending.kind === 'propose'
      ? sendProposal(operation, pending, true)
      : sendAccept(operation, pending, true);
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    propose, refresh, open, accept, reconcile, retrySameRequest,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      // Abort reads only; an in-flight POST may still complete on the server.
      if (active && !active.mutationStarted) active.reads.abort();
      active = null;
      listeners.clear();
    },
  };
}
