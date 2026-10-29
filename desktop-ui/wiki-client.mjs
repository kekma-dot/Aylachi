const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = method => Object.assign(new Error('INVALID_WIKI_RESPONSE'), { code: 'INVALID_WIKI_RESPONSE', unknownOutcome: method === 'POST' });
function id(value) { if (!uuid(value)) throw new TypeError('INVALID_WIKI_ID'); return encodeURIComponent(value); }
function revision(value) { if (!uuid(value)) throw new TypeError('INVALID_REVISION'); return value; }
function note(value, fields = ['id', 'revision']) { return exact(value, fields) && uuid(value.id) && uuid(value.revision); }
function response(method, value, valid) { if (!valid(value)) throw invalid(method); return value; }

export function createWikiClient({ hubClient } = {}) {
  if (!hubClient || typeof hubClient.moduleRequest !== 'function') throw new TypeError('INVALID_HUB_CLIENT');
  const call = async (method, path, body, signal, validate) => {
    const value = await hubClient.moduleRequest({ method, path, body, signal });
    return response(method, value, validate);
  };
  const query = entries => new URLSearchParams(entries).toString();
  return {
    create({ content, signal } = {}) {
      if (typeof content !== 'string') throw new TypeError('INVALID_CONTENT');
      return call('POST', '/v1/modules/wiki/notes', { content }, signal, value => note(value));
    },
    read(noteId, { revision: selectedRevision, signal } = {}) {
      const suffix = selectedRevision === undefined ? '' : `?${query([['revision', revision(selectedRevision)]])}`;
      return call('GET', `/v1/modules/wiki/notes/${id(noteId)}${suffix}`, undefined, signal, value =>
        note(value, ['id', 'revision', 'content']) && typeof value.content === 'string');
    },
    update(noteId, { content, expectedRevision, signal } = {}) {
      if (typeof content !== 'string') throw new TypeError('INVALID_CONTENT');
      const expected = revision(expectedRevision);
      return call('POST', `/v1/modules/wiki/notes/${id(noteId)}`, { content, expectedRevision: expected }, signal, value => note(value));
    },
    search(searchQuery, { signal } = {}) {
      if (typeof searchQuery !== 'string') throw new TypeError('INVALID_QUERY');
      return call('GET', `/v1/modules/wiki/notes?${query([['query', searchQuery]])}`, undefined, signal, value =>
        exact(value, ['notes']) && Array.isArray(value.notes) && value.notes.every(item => note(item)));
    },
    history(noteId, { signal } = {}) {
      return call('GET', `/v1/modules/wiki/notes/${id(noteId)}/history`, undefined, signal, value =>
        exact(value, ['revisions']) && Array.isArray(value.revisions) && value.revisions.every(uuid));
    },
    diff(noteId, { fromRevision, toRevision, signal } = {}) {
      const from = revision(fromRevision), to = revision(toRevision);
      const params = query([['fromRevision', from], ['toRevision', to]]);
      return call('GET', `/v1/modules/wiki/notes/${id(noteId)}/diff?${params}`, undefined, signal, value =>
        exact(value, ['changes']) && Array.isArray(value.changes) && value.changes.every(change =>
          exact(change, ['start', 'remove', 'insert']) && Number.isSafeInteger(change.start) && change.start >= 0 &&
          Array.isArray(change.remove) && change.remove.every(line => typeof line === 'string') &&
          Array.isArray(change.insert) && change.insert.every(line => typeof line === 'string')));
    },
    restore(noteId, { revision: targetRevision, expectedRevision, signal } = {}) {
      const target = revision(targetRevision), expected = revision(expectedRevision);
      return call('POST', `/v1/modules/wiki/notes/${id(noteId)}/restore`, {
        revision: target, expectedRevision: expected,
      }, signal, value => note(value));
    },
    links(noteId, { signal } = {}) {
      return call('GET', `/v1/modules/wiki/notes/${id(noteId)}/links`, undefined, signal, value =>
        exact(value, ['links']) && Array.isArray(value.links) && value.links.every(uuid));
    },
  };
}
