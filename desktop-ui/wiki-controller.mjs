const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const errorCode = failure => failure?.status === 409 ? 'CONFLICT' : SAFE_CODE.test(failure?.code ?? '') ? failure.code : 'REQUEST_FAILED';

export function createWikiController({ client } = {}) {
  const methods = ['search', 'read', 'create', 'update', 'history', 'diff', 'restore', 'links'];
  if (!client || methods.some(method => typeof client[method] !== 'function')) throw new TypeError('INVALID_WIKI_CLIENT');

  const listeners = new Set();
  let state = { notes: [], selected: null, draft: '', dirty: false, history: [], changes: [], links: [], busy: false, error: null, conflict: false, uncertain: false };
  let active = null, generation = 0, disposed = false;
  // ponytail: one in-flight operation for this controller; split reads only if the UI needs concurrent panels.
  function publish(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function begin() {
    if (disposed || active) return null;
    const operation = { generation: ++generation, reads: new AbortController(), writes: new AbortController(), mutationStarted: false };
    active = operation;
    publish({ busy: true, error: null });
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
  function failed(operation, failure) {
    if (!current(operation)) return false;
    const code = errorCode(failure);
    publish(code === 'CONFLICT'
      ? { error: code, conflict: true }
      : failure?.unknownOutcome === true
        ? { error: 'OUTCOME_UNKNOWN', uncertain: true }
        : { error: code });
    return false;
  }
  function canWrite() {
    if (state.uncertain) return blocked('OUTCOME_UNKNOWN');
    if (state.conflict) return blocked('CONFLICT');
    return true;
  }

  async function search(query) {
    const operation = begin();
    if (!operation) return false;
    try {
      const result = await client.search(query, { signal: operation.reads.signal });
      if (!current(operation)) return false;
      publish({ notes: result.notes });
      return true;
    } catch (failure) { return failed(operation, failure); }
    finally { finish(operation); }
  }

  async function openNote(id, { discard = false } = {}) {
    if (active || disposed) return false;
    if (state.uncertain) return blocked('OUTCOME_UNKNOWN');
    if ((state.dirty || state.conflict) && !discard) return blocked(state.conflict ? 'CONFLICT' : 'UNSAVED_DRAFT');
    const operation = begin();
    if (!operation) return false;
    try {
      const [note, links] = await Promise.all([
        client.read(id, { signal: operation.reads.signal }),
        client.links(id, { signal: operation.reads.signal }),
      ]);
      if (!current(operation)) return false;
      if (note.id !== id) throw Object.assign(new Error(), { code: 'INVALID_NOTE_ID' });
      publish({ selected: note, draft: note.content, dirty: false, history: [], changes: [], links: links.links, conflict: false, error: null });
      return true;
    } catch (failure) { return failed(operation, failure); }
    finally { finish(operation); }
  }

  function newNote({ discard = false } = {}) {
    if (active || disposed) return false;
    if (state.uncertain) return blocked('OUTCOME_UNKNOWN');
    if ((state.dirty || state.conflict) && !discard) return blocked(state.conflict ? 'CONFLICT' : 'UNSAVED_DRAFT');
    publish({ selected: null, draft: '', dirty: false, history: [], changes: [], links: [], conflict: false, error: null });
    return true;
  }

  function edit(text) {
    if (active || disposed) return false;
    if (state.uncertain) return blocked('OUTCOME_UNKNOWN');
    if (typeof text !== 'string') return blocked('INVALID_CONTENT');
    publish({ draft: text, dirty: text !== (state.selected?.content ?? ''), error: state.conflict ? 'CONFLICT' : null });
    return true;
  }

  async function save() {
    if (active || disposed) return false;
    if (!canWrite()) return false;
    if (!state.dirty) return true;
    const operation = begin();
    if (!operation) return false;
    operation.mutationStarted = true;
    const content = state.draft, selected = state.selected;
    try {
      const receipt = selected
        ? await client.update(selected.id, { content, expectedRevision: selected.revision, signal: operation.writes.signal })
        : await client.create({ content, signal: operation.writes.signal });
      if (!current(operation)) return false;
      if (selected && receipt.id !== selected.id) {
        publish({ error: 'OUTCOME_UNKNOWN', uncertain: true });
        return false;
      }
      publish({ selected: { id: receipt.id, revision: receipt.revision, content }, draft: content, dirty: false, conflict: false, uncertain: false, error: null });
      return true;
    } catch (failure) { return failed(operation, failure); }
    finally { finish(operation); }
  }

  async function loadHistory() {
    if (active || disposed) return false;
    if (!state.selected) return blocked('NO_NOTE_SELECTED');
    const operation = begin(), id = state.selected.id;
    try {
      const result = await client.history(id, { signal: operation.reads.signal });
      if (!current(operation)) return false;
      publish({ history: result.revisions });
      return true;
    } catch (failure) { return failed(operation, failure); }
    finally { finish(operation); }
  }

  async function compare(fromRevision, toRevision) {
    if (active || disposed) return false;
    if (!state.selected) return blocked('NO_NOTE_SELECTED');
    const operation = begin(), id = state.selected.id;
    try {
      const result = await client.diff(id, { fromRevision, toRevision, signal: operation.reads.signal });
      if (!current(operation)) return false;
      publish({ changes: result.changes });
      return true;
    } catch (failure) { return failed(operation, failure); }
    finally { finish(operation); }
  }

  async function reconcile() {
    if (active || disposed) return false;
    if (!state.selected) return blocked(state.uncertain ? 'OUTCOME_UNKNOWN_NO_NOTE_ID' : 'NO_NOTE_SELECTED');
    const operation = begin(), previous = state.selected;
    try {
      const [note, result] = await Promise.all([
        client.read(previous.id, { signal: operation.reads.signal }),
        client.history(previous.id, { signal: operation.reads.signal }),
      ]);
      if (!current(operation)) return false;
      if (note.id !== previous.id) throw Object.assign(new Error(), { code: 'INVALID_NOTE_ID' });
      const conflictUnchanged = state.conflict && note.revision === previous.revision;
      const preserveDraft = state.dirty || state.uncertain;
      publish({
        selected: note,
        history: result.revisions,
        // A read cannot prove an unknown write finished; preserve its draft and uncertainty.
        draft: preserveDraft ? state.draft : note.content,
        dirty: preserveDraft ? state.dirty : false,
        uncertain: state.uncertain,
        conflict: conflictUnchanged,
        error: state.uncertain ? 'OUTCOME_UNKNOWN' : conflictUnchanged ? 'CONFLICT' : null,
      });
      return true;
    } catch (failure) { return failed(operation, failure); }
    finally { finish(operation); }
  }

  async function restore(revision) {
    if (active || disposed) return false;
    if (!canWrite()) return false;
    if (!state.selected) return blocked('NO_NOTE_SELECTED');
    if (state.dirty) return blocked('UNSAVED_DRAFT');
    const operation = begin(), selected = state.selected;
    try {
      const target = await client.read(selected.id, { revision, signal: operation.reads.signal });
      if (!current(operation)) return false;
      if (target.id !== selected.id || target.revision !== revision) throw Object.assign(new Error(), { code: 'INVALID_NOTE_ID' });
      operation.mutationStarted = true;
      const receipt = await client.restore(selected.id, { revision, expectedRevision: selected.revision, signal: operation.writes.signal });
      if (!current(operation)) return false;
      if (receipt.id !== selected.id) {
        publish({ error: 'OUTCOME_UNKNOWN', uncertain: true });
        return false;
      }
      publish({ selected: { id: receipt.id, revision: receipt.revision, content: target.content }, draft: target.content, dirty: false, history: [], changes: [], conflict: false, uncertain: false, error: null });
      return true;
    } catch (failure) { return failed(operation, failure); }
    finally { finish(operation); }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    search, openNote, newNote, edit, save, loadHistory, compare, restore, reconcile,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      // Abort only a read (including restore's preflight); never imply an in-flight write was cancelled.
      if (active && !active.mutationStarted) active.reads.abort();
      active = null;
      listeners.clear();
    },
  };
}
