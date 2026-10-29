const ID = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const INSTANCE = /^[a-f0-9]{32}$/;
const BASE = '/v1/modules/source-workbench/files';
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const digest = v => typeof v === 'string' && HASH.test(v);
const file = (v, content = false) => exact(v, ['id', 'path', 'sha256', 'baselineSha256', ...(content ? ['content', 'instanceId'] : [])]) &&
  typeof v.id === 'string' && ID.test(v.id) && typeof v.path === 'string' && v.path.length > 0 && v.path.length <= 4096 &&
  digest(v.sha256) && digest(v.baselineSha256) && (!content || typeof v.content === 'string' && new TextEncoder().encode(v.content).length <= 32768 && INSTANCE.test(v.instanceId));
const failure = (code, unknownOutcome = false) => Object.assign(new Error(code), { code, unknownOutcome });

export function createSourceController({ hubClient } = {}) {
  if (typeof hubClient?.moduleRequest !== 'function') throw new TypeError('INVALID_SOURCE_CLIENT');
  const listeners = new Set();
  let state = { files: [], selected: null, draft: '', dirty: false, busy: false, error: null, uncertain: false, conflict: false, diff: null };
  let active = null, disposed = false, instanceId;
  const publish = patch => { if (!disposed) { state = { ...state, ...patch }; for (const f of listeners) f(); } };
  const blocked = code => { if (!active && !disposed) publish({ error: code }); return false; };
  const idle = () => !active && !disposed;
  const canChange = () => idle() && !state.uncertain && !state.conflict;
  async function request(method, path, body, valid, signal) {
    const result = await hubClient.moduleRequest({ method, path, body, signal });
    if (!valid(result)) throw failure('INVALID_SOURCE_RESPONSE', method === 'POST');
    return result;
  }
  // One operation at a time; disposing a pending write must not imply cancellation.
  async function run(fn, mutation = false) {
    if (!idle()) return false;
    const op = { abort: new AbortController(), mutation }; active = op; publish({ busy: true, error: null });
    try { return await fn(op.abort.signal); }
    catch (err) {
      if (!disposed) publish(err?.status === 409 ? { conflict: true, error: 'CONFLICT' } : err?.unknownOutcome
        ? { uncertain: true, error: 'OUTCOME_UNKNOWN' } : { error: 'SOURCE_REQUEST_FAILED' });
      return false;
    } finally { if (active === op) { active = null; publish({ busy: false }); } }
  }
  const read = (id, signal) => request('GET', `${BASE}/${id}`, undefined, v => file(v, true) && v.id === id, signal);
  const api = {
    getSnapshot: () => state,
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    refresh() {
      if (!canChange() || state.dirty) return blocked('DRAFT_OR_OUTCOME_PENDING');
      return run(async signal => {
        const result = await request('GET', BASE, undefined, v => exact(v, ['files', 'instanceId']) && typeof v.instanceId === 'string' && INSTANCE.test(v.instanceId) &&
          Array.isArray(v.files) && v.files.length <= 16 && v.files.every(f => file(f)) && new Set(v.files.map(f => f.id)).size === v.files.length, signal);
        const changed = instanceId && result.instanceId !== instanceId;
        instanceId = result.instanceId;
        publish({ files: result.files, ...(changed ? { selected: null, draft: '', diff: null } : {}) });
        return true;
      });
    },
    selectFile(id) {
      if (!canChange() || state.dirty) return blocked('DRAFT_OR_OUTCOME_PENDING');
      if (typeof id !== 'string' || !ID.test(id) || !state.files.some(f => f.id === id)) return blocked('INVALID_SOURCE_ID');
      return run(async signal => {
        const selected = await read(id, signal);
        if (selected.instanceId !== instanceId) throw failure('SOURCE_INSTANCE_CHANGED');
        publish({ selected, draft: selected.content, dirty: false, diff: null }); return true;
      });
    },
    edit(content) {
      if (!idle() || state.uncertain || !state.selected) return false;
      if (typeof content !== 'string') return blocked('INVALID_CONTENT');
      publish({ draft: content, dirty: content !== state.selected.content, diff: null }); return true;
    },
    discardDraft() {
      if (!idle() || state.uncertain || !state.selected) return false;
      publish({ draft: state.selected.content, dirty: false, conflict: false, error: null }); return true;
    },
    save() {
      if (!canChange() || !state.selected) return blocked('DRAFT_OR_OUTCOME_PENDING');
      if (!state.dirty) return Promise.resolve(true);
      const selected = state.selected, content = state.draft;
      return run(async signal => {
        const receipt = await request('POST', `${BASE}/${selected.id}`, { content, expectedSha256: selected.sha256, instanceId: selected.instanceId },
          v => exact(v, ['id', 'sha256', 'baselineSha256', 'instanceId']) && v.id === selected.id && digest(v.sha256) &&
            v.baselineSha256 === selected.baselineSha256 && v.instanceId === selected.instanceId, signal);
        publish({ selected: { ...selected, content, sha256: receipt.sha256 }, draft: content, dirty: false, diff: null }); return true;
      }, true);
    },
    reconcile() {
      if (!idle() || !state.selected) return false;
      const previous = state.selected;
      return run(async signal => {
        const selected = await read(previous.id, signal);
        const draft = state.dirty || state.uncertain || state.conflict ? state.draft : selected.content;
        const conflict = state.conflict && previous.sha256 === selected.sha256 && previous.instanceId === selected.instanceId;
        instanceId = selected.instanceId;
        // A read does not prove an unknown POST has finished; never automatically replay or unlock it.
        publish({ selected, draft, dirty: draft !== selected.content, conflict, diff: null,
          error: state.uncertain ? 'OUTCOME_UNKNOWN' : conflict ? 'CONFLICT' : null }); return true;
      });
    },
    loadDiff() {
      if (!canChange() || state.dirty || !state.selected) return false;
      const selected = state.selected;
      return run(async signal => {
        let offset = 0, total, encoded = '';
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        for (let page = 0; page < 32; page++) {
          const query = new URLSearchParams({ offset: String(offset), sha256: selected.sha256, instanceId: selected.instanceId });
          const part = await request('GET', `${BASE}/${selected.id}/diff?${query}`, undefined, v =>
            exact(v, ['id', 'fromSha256', 'toSha256', 'instanceId', 'offset', 'nextOffset', 'total', 'chunk']) &&
            v.id === selected.id && v.instanceId === selected.instanceId && v.fromSha256 === selected.baselineSha256 && v.toSha256 === selected.sha256 &&
            v.offset === offset && Number.isSafeInteger(v.total) && v.total > 0 && v.total <= 524288 && (total === undefined || v.total === total) &&
            typeof v.chunk === 'string' && v.chunk.length > 0 && v.chunk.length <= 16384 && offset + v.chunk.length <= v.total &&
            v.nextOffset === (offset + v.chunk.length === v.total ? null : offset + v.chunk.length), deadline);
          total = part.total; encoded += part.chunk;
          if (part.nextOffset === null) break;
          offset = part.nextOffset;
        }
        if (encoded.length !== total) throw failure('INVALID_SOURCE_RESPONSE');
        const changes = JSON.parse(encoded);
        if (!Array.isArray(changes) || !changes.every(c => exact(c, ['start', 'remove', 'insert']) && Number.isSafeInteger(c.start) && c.start >= 0 &&
            ['remove', 'insert'].every(k => Array.isArray(c[k]) && c[k].every(s => typeof s === 'string')))) throw failure('INVALID_SOURCE_RESPONSE');
        publish({ diff: { id: selected.id, fromSha256: selected.baselineSha256, toSha256: selected.sha256, changes } }); return true;
      });
    },
    dispose() {
      if (disposed) return; disposed = true;
      if (active && !active.mutation) active.abort.abort();
      listeners.clear();
    },
  };
  return api;
}
