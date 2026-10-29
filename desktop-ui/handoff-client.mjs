const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_TEXT = 16 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeId = value => typeof value === 'string' && SAFE_ID.test(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const invalid = method => Object.assign(new Error('INVALID_HANDOFF_RESPONSE'), { code: 'INVALID_HANDOFF_RESPONSE', unknownOutcome: method === 'POST' });

function checkedSource(value) {
  if (!object(value) || !['cardId', 'kind', 'id'].every(key => Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !['cardId', 'kind', 'id', 'revision'].includes(key)) ||
      !safeId(value.cardId) || !safeId(value.id)) throw new TypeError('INVALID_SOURCE');
  if (value.kind === 'command') {
    if (Object.hasOwn(value, 'revision')) throw new TypeError('INVALID_SOURCE');
    return { cardId: value.cardId, kind: 'command', id: value.id };
  }
  if (value.kind === 'wiki' && uuid(value.revision)) {
    return { cardId: value.cardId, kind: 'wiki', id: value.id, revision: value.revision.toLowerCase() };
  }
  throw new TypeError('INVALID_SOURCE');
}

function sameSource(a, b) {
  const source = checkedSource(a), expected = checkedSource(b);
  return source.cardId === expected.cardId && source.kind === expected.kind && source.id === expected.id && source.revision === expected.revision;
}

function validRecord(value, summary = false) {
  const keys = ['id', 'owner', 'requestId', 'payloadHash', 'state', 'source', 'targetCardId', 'snapshot', 'createdAt', 'acceptedAt'];
  if (!exact(value, keys) || !uuid(value.id) || !safeId(value.owner) || !safeId(value.requestId) ||
      typeof value.payloadHash !== 'string' || !HASH.test(value.payloadHash) || !['pending', 'accepted'].includes(value.state) || !safeId(value.targetCardId) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      (value.state === 'pending' ? value.acceptedAt !== null : !Number.isSafeInteger(value.acceptedAt) || value.acceptedAt < 0)) return false;
  let source;
  try { source = checkedSource(value.source); } catch { return false; }
  if (source.cardId === value.targetCardId) return false;
  if (summary) return exact(value.snapshot, ['sha256']) && typeof value.snapshot.sha256 === 'string' && HASH.test(value.snapshot.sha256);
  return exact(value.snapshot, ['text', 'sha256']) && typeof value.snapshot.text === 'string' &&
    new TextEncoder().encode(value.snapshot.text).byteLength <= MAX_TEXT && typeof value.snapshot.sha256 === 'string' && HASH.test(value.snapshot.sha256);
}

function response(method, value, valid) {
  if (!valid(value)) throw invalid(method);
  return value;
}

export function createHandoffClient({ hubClient } = {}) {
  if (!hubClient || typeof hubClient.moduleRequest !== 'function') throw new TypeError('INVALID_HUB_CLIENT');
  const call = async (method, path, body, signal, validate) => {
    const value = await hubClient.moduleRequest({ method, path, body, signal });
    return response(method, value, validate);
  };

  return {
    propose({ requestId, source: sourceInput, targetCardId, signal } = {}) {
      if (!safeId(requestId) || !safeId(targetCardId)) throw new TypeError('INVALID_PROPOSAL');
      const source = checkedSource(sourceInput);
      if (source.cardId === targetCardId) throw new TypeError('INVALID_PROPOSAL');
      return call('POST', '/v1/modules/handoff', { requestId, source, targetCardId }, signal, value =>
        exact(value, ['record', 'duplicate']) && typeof value.duplicate === 'boolean' && validRecord(value.record) &&
        value.record.requestId === requestId && sameSource(value.record.source, source) && value.record.targetCardId === targetCardId);
    },
    read(handoffId, { signal } = {}) {
      if (!uuid(handoffId)) throw new TypeError('INVALID_HANDOFF_ID');
      return call('GET', `/v1/modules/handoff/${encodeURIComponent(handoffId)}`, undefined, signal, value =>
        exact(value, ['record']) && validRecord(value.record) && value.record.id === handoffId);
    },
    list(targetCardId, { limit = 20, offset = 0, signal } = {}) {
      if (!safeId(targetCardId) || !Number.isInteger(limit) || limit < 1 || limit > 20 ||
          !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new TypeError('INVALID_HANDOFF_RANGE');
      const query = new URLSearchParams({ targetCardId, limit: String(limit), offset: String(offset) });
      return call('GET', `/v1/modules/handoff?${query}`, undefined, signal, value =>
        exact(value, ['items']) && Array.isArray(value.items) && value.items.every(item =>
          validRecord(item, true) && item.targetCardId === targetCardId));
    },
    accept(handoffId, { requestId, signal } = {}) {
      if (!uuid(handoffId) || !safeId(requestId)) throw new TypeError('INVALID_ACCEPT');
      return call('POST', `/v1/modules/handoff/${encodeURIComponent(handoffId)}/accept`, { requestId }, signal, value =>
        exact(value, ['record', 'duplicate']) && typeof value.duplicate === 'boolean' && validRecord(value.record) &&
        value.record.id === handoffId && value.record.state === 'accepted');
    },
  };
}
