const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITIES = new Set(['chat', 'models', 'artifacts', 'events']);
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = value => typeof value === 'string' && ID.test(value);
const publicView = adapter => Object.freeze({ id: adapter.id, revision: adapter.revision, capabilities: Object.freeze([...adapter.capabilities]) });

function snapshotAdapter(value) {
  if (!plain(value) || !validId(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Array.isArray(value.capabilities) || !value.capabilities.includes('chat') || value.capabilities.some(capability => !CAPABILITIES.has(capability)) ||
      new Set(value.capabilities).size !== value.capabilities.length || typeof value.run !== 'function' ||
      (value.health !== undefined && typeof value.health !== 'function') || (value.dispose !== undefined && typeof value.dispose !== 'function')) throw bad('INVALID_BACKEND_ADAPTER');
  return Object.freeze({ id: value.id, revision: value.revision, capabilities: Object.freeze([...value.capabilities]),
    run: value.run, health: value.health, dispose: value.dispose });
}

export function createBackendRegistry({ store, adapters, defaultBackendId = 'pi' } = {}) {
  if (!store || typeof store.bind !== 'function' || typeof store.get !== 'function' || !Array.isArray(adapters) || !adapters.length) throw new TypeError('backend store and adapters required');
  const byId = new Map();
  for (const input of adapters) {
    const adapter = snapshotAdapter(input);
    if (byId.has(adapter.id)) throw bad('DUPLICATE_BACKEND');
    byId.set(adapter.id, adapter);
  }
  if (!byId.has(defaultBackendId)) throw bad('DEFAULT_BACKEND_UNAVAILABLE');
  let defaultId = defaultBackendId, closed = false, closePromise;
  const adapterFor = id => {
    if (closed) throw bad('BACKEND_REGISTRY_CLOSED', 409);
    const adapter = byId.get(id);
    if (!adapter) throw bad('BACKEND_NOT_FOUND', 404);
    return adapter;
  };
  function bind(card, backendId = defaultId) {
    if (!plain(card) || !validId(card.id) || !validId(card.sessionId)) throw bad('INVALID_CARD');
    const adapter = adapterFor(backendId);
    return store.bind({ cardId: card.id, sessionId: card.sessionId, backendId: adapter.id, backendRevision: adapter.revision });
  }
  function binding(card) {
    if (!plain(card) || !validId(card.id) || !validId(card.sessionId)) throw bad('INVALID_CARD');
    return store.get(card.id) ?? bind(card);
  }
  function list() { return { defaultBackendId: defaultId, backends: [...byId.values()].map(publicView) }; }
  return Object.freeze({
    bind,
    binding,
    conversation(cardId) { return store.get(cardId); },
    validate(backendId) { return publicView(adapterFor(backendId)); },
    list,
    setDefault(backendId) { adapterFor(backendId); defaultId = backendId; return list(); },
    async run(input) {
      const bound = binding(input?.card);
      if (bound.sessionId !== input.card.sessionId) throw bad('BACKEND_CONVERSATION_MISMATCH', 409);
      const adapter = adapterFor(bound.backendId);
      if (adapter.revision !== bound.backendRevision) throw bad('BACKEND_REVISION_CONFLICT', 409);
      // `bound` is immutable: changing the registry default cannot move this command.
      return adapter.run({ ...input, backend: bound });
    },
    async health() {
      return Promise.all([...byId.values()].map(async adapter => {
        try {
          const health = adapter.health ? await adapter.health() : { state: 'READY' };
          if (!plain(health) || !['READY', 'DEGRADED', 'OFFLINE'].includes(health.state)) throw new Error('INVALID_HEALTH');
          return { ...publicView(adapter), health: { state: health.state } };
        } catch { return { ...publicView(adapter), health: { state: 'OFFLINE' } }; }
      }));
    },
    shutdown() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = Promise.allSettled([...byId.values()].map(adapter => adapter.dispose?.())).then(() => {});
      return closePromise;
    },
  });
}
