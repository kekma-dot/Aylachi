import { randomBytes } from 'node:crypto';

const LIMIT = 64 * 1024;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function exact(value, keys) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) throw fail(400, 'invalid_request');
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw fail(400, 'invalid_request');
  }
}
function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMIT) throw fail(413, 'too_large');
  return value;
}
function publicError(error) {
  if (error?.status === 400 && error.code === 'invalid_request' || error?.status === 413 && error.code === 'too_large' ||
      error?.status === 409 && error.code === 'conflict') return error;
  if (['UNKNOWN_FILE', 'POLICY_DENIED'].includes(error?.code)) return fail(404, 'not_found');
  if (error?.code === 'CONFLICT') return fail(409, 'conflict');
  if (['INVALID_FILE_ID', 'INVALID_SAVE', 'INVALID_UTF8', 'INVALID_SOURCE'].includes(error?.code)) return fail(400, 'invalid_request');
  return fail(500, 'source_unavailable');
}

// Trusted module descriptors use existing Hub authorization; no caller-selected paths or projects.
export function createSourceRoutes({ store, projectId } = {}) {
  if (!store || !['list', 'read', 'save', 'diff'].every(k => typeof store[k] === 'function') ||
      typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) throw new TypeError('INVALID_SOURCE_MODULE');
  const instanceId = randomBytes(16).toString('hex');
  const base = '/v1/modules/source-workbench/files';
  return [
    ['GET', base, 'list', []],
    ['GET', `${base}/:id`, 'read', ['id']],
    ['POST', `${base}/:id`, 'save', ['id']],
    ['GET', `${base}/:id/diff`, 'diff', ['id']],
  ].map(([method, path, action, paramsKeys]) => Object.freeze({
    method, path, operation: `source.${action}`, effect: action === 'save' ? 'write' : 'read', target: Object.freeze({ projectId }),
    async handle({ actor, params = {}, query = {}, body = {} }) {
      try {
        exact(params, paramsKeys); exact(query, action === 'diff' ? ['offset', 'sha256', 'instanceId'] : []);
        exact(body, action === 'save' ? ['content', 'expectedSha256', 'instanceId'] : []);
        const id = params.id;
        if (paramsKeys.length && (typeof id !== 'string' || !ID.test(id))) throw fail(400, 'invalid_request');
        let result;
        if (action === 'save') {
          if (body.instanceId !== instanceId) throw fail(409, 'conflict');
          if (typeof body.content !== 'string' || typeof body.expectedSha256 !== 'string' || !HASH.test(body.expectedSha256)) throw fail(400, 'invalid_request');
          // The next GET must remain representable. Reject BEFORE backup or source mutation.
          const previous = await store.read({ actor, id });
          bounded({ ...previous, content: body.content, sha256: '0'.repeat(64), instanceId });
          const saved = await store.save({ actor, id, content: body.content, expectedSha256: body.expectedSha256 });
          result = { id: saved.id, sha256: saved.sha256, baselineSha256: saved.baselineSha256 };
        } else if (action === 'diff') {
          if (query.instanceId !== instanceId) throw fail(409, 'conflict');
          if (typeof query.sha256 !== 'string' || !HASH.test(query.sha256) || typeof query.offset !== 'string' || !/^(0|[1-9]\d{0,5})$/.test(query.offset)) throw fail(400, 'invalid_request');
          const diff = await store.diff({ actor, id });
          if (diff.toSha256 !== query.sha256) throw fail(409, 'conflict');
          const encoded = JSON.stringify(diff.changes), offset = Number(query.offset);
          if (encoded.length > 524288 || offset >= encoded.length) throw fail(400, 'invalid_request');
          // Bound wire size without truncating legitimate full-file diffs; every page binds the same snapshot.
          const chunk = encoded.slice(offset, offset + 16384), end = offset + chunk.length;
          result = { id, fromSha256: diff.fromSha256, toSha256: diff.toSha256, offset,
            nextOffset: end === encoded.length ? null : end, total: encoded.length, chunk };
        } else result = await store[action]({ actor, ...(id === undefined ? {} : { id }) });
        return { status: 200, body: bounded({ ...result, instanceId }) };
      } catch (error) { throw publicError(error); }
    },
  }));
}
