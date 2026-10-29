import { randomUUID } from 'node:crypto';
import { snapshotBrowserPolicy, browserUrl } from './policy.mjs';

const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const key = value => { if (typeof value !== 'string' || !value.length || value.length > 256) throw bad('INVALID_IDEMPOTENCY_KEY'); return value; };
const abortReason = signal => signal?.reason ?? bad('ABORTED', 499);
async function waitShared(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortReason(signal);
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

export function createBrowserPlane({ store, remoteReadOnly, localInteractive } = {}) {
  if (!store) throw new TypeError('BROWSER_STORE_REQUIRED');
  const adapters = { 'remote-read-only': remoteReadOnly, 'local-interactive': localInteractive };
  const inFlight = new Map();
  function adapter(mode) {
    const value = adapters[mode];
    if (!value) throw bad('BROWSER_BACKEND_UNAVAILABLE', 404);
    return value;
  }
  async function effect({ idempotencyKey, operation, identity, signal, load, commit }) {
    key(idempotencyKey);
    const previous = store.replay(idempotencyKey, operation, identity);
    if (previous) return previous;
    const serialized = JSON.stringify(identity), current = inFlight.get(idempotencyKey);
    if (current) {
      if (current.operation !== operation || current.identity !== serialized) throw bad('IDEMPOTENCY_CONFLICT', 409);
      return waitShared(current.promise, signal);
    }
    const promise = (async () => {
      if (identity.expectedRevision !== undefined && store.getSession(identity.sessionId).revision !== identity.expectedRevision) throw bad('REVISION_CONFLICT', 409);
      if (signal?.aborted) throw abortReason(signal);
      const loaded = await load();
      return commit(loaded);
    })();
    inFlight.set(idempotencyKey, { operation, identity: serialized, promise });
    try { return await promise; }
    finally { if (inFlight.get(idempotencyKey)?.promise === promise) inFlight.delete(idempotencyKey); }
  }
  return Object.freeze({
    read(sessionId) { return store.read(sessionId); },
    health() { return Object.fromEntries(Object.entries(adapters).map(([mode, value]) => [mode, value ? value.health() : { state: 'UNAVAILABLE' }])); },
    create({ sessionId = randomUUID(), canvasId, mode, allowedHosts, idempotencyKey }) {
      const policy = snapshotBrowserPolicy({ allowedHosts }, mode);
      const backend = adapter(mode);
      key(idempotencyKey);
      if (inFlight.has(idempotencyKey)) throw bad('IDEMPOTENCY_CONFLICT', 409);
      return store.create({ id: sessionId, canvasId, mode, backendId: backend.id, policy,
        tab: { id: `tab-${sessionId}`, url: '', title: 'New tab' }, idempotencyKey });
    },
    async openTab({ sessionId, expectedRevision, url, idempotencyKey, signal }) {
      const session = store.getSession(sessionId);
      if (session.mode !== 'remote-read-only') throw bad('LOCAL_BROWSER_CONTROLS_NAVIGATION', 409);
      const normalized = browserUrl(url, session.policy).href;
      const identity = { sessionId, expectedRevision, url: normalized };
      return effect({ idempotencyKey, operation: 'open-tab', identity, signal,
        load: () => adapter(session.mode).navigate({ url: normalized, policy: session.policy, signal }),
        commit: snapshot => store.openTab({ sessionId, expectedRevision, identity,
          tab: { id: randomUUID(), url: normalized, title: snapshot.title, snapshot: { ...snapshot, id: randomUUID() } }, idempotencyKey }) });
    },
    async navigate({ sessionId, expectedRevision, url, idempotencyKey, signal }) {
      const session = store.getSession(sessionId);
      if (session.mode !== 'remote-read-only') throw bad('LOCAL_BROWSER_CONTROLS_NAVIGATION', 409);
      const normalized = browserUrl(url, session.policy).href;
      const identity = { sessionId, tabId: session.activeTabId, expectedRevision, url: normalized };
      return effect({ idempotencyKey, operation: 'snapshot', identity, signal,
        load: () => adapter(session.mode).navigate({ url: normalized, policy: session.policy, signal }),
        commit: snapshot => store.commitSnapshot({ sessionId, tabId: session.activeTabId, expectedRevision, identity,
          snapshot: { ...snapshot, id: randomUUID() }, idempotencyKey }) });
    },
    async refresh({ sessionId, expectedRevision, idempotencyKey, signal }) {
      const session = store.getSession(sessionId);
      const identity = { sessionId, tabId: session.activeTabId, expectedRevision, refresh: true };
      return effect({ idempotencyKey, operation: 'snapshot', identity, signal,
        load: async () => {
          if (session.mode === 'local-interactive') return adapter(session.mode).snapshot({ sessionId, policy: session.policy, signal });
          const tab = store.getTab(session.activeTabId, sessionId);
          if (!tab.url) throw bad('BROWSER_URL_REQUIRED');
          return adapter(session.mode).navigate({ url: tab.url, policy: session.policy, signal });
        },
        commit: snapshot => store.commitSnapshot({ sessionId, tabId: session.activeTabId, expectedRevision, identity,
          snapshot: { ...snapshot, id: randomUUID() }, idempotencyKey }) });
    },
    activate({ sessionId, tabId, expectedRevision, idempotencyKey }) {
      key(idempotencyKey);
      if (inFlight.has(idempotencyKey)) throw bad('IDEMPOTENCY_CONFLICT', 409);
      return store.activate({ sessionId, tabId, expectedRevision, idempotencyKey });
    },
  });
}
