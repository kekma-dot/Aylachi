const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const invalid = () => Object.assign(new Error('DELEGATION_BOOTSTRAP_INVALID'), { code: 'DELEGATION_BOOTSTRAP_INVALID' });

// Exact own-data snapshots are a trust boundary, not ordinary object spreading.
export function exactDataRecord(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || !keys.every(key => own.includes(key))) return null;
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}

export function checkedSessionIds(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isInteger(length) || length < 1 || length > 3) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes('length')) return null;
    const ids = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'string' || !SESSION_ID.test(descriptor.value)) return null;
      ids.push(descriptor.value);
    }
    return new Set(ids).size === ids.length ? ids : null;
  } catch { return null; }
}

function validLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !!url.port &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash &&
      [url.origin, `${url.origin}/`].includes(value);
  } catch { return false; }
}

export function snapshotDelegationBootstrap(value) {
  const extended = exactDataRecord(value, ['type', 'connection', 'parentSessionIds', 'artifactEngine', 'themes']);
  const artifactOnly = exactDataRecord(value, ['type', 'connection', 'parentSessionIds', 'artifactEngine']);
  const frame = extended ?? artifactOnly ?? exactDataRecord(value, ['type', 'connection', 'parentSessionIds']);
  const connection = frame && exactDataRecord(frame.connection, ['baseUrl', 'bearer']);
  const parentSessionIds = frame && checkedSessionIds(frame.parentSessionIds);
  if (!frame || (extended || artifactOnly) && frame.artifactEngine !== true || extended && extended.themes !== true || frame.type !== 'delegation_bootstrap' || !connection || !parentSessionIds ||
      !validLoopbackUrl(connection.baseUrl) || typeof connection.bearer !== 'string' || !TOKEN.test(connection.bearer)) throw invalid();
  return Object.freeze({
    type: 'delegation_bootstrap',
    connection: Object.freeze({ baseUrl: connection.baseUrl, bearer: connection.bearer }),
    parentSessionIds: Object.freeze([...parentSessionIds]),
    ...(extended || artifactOnly ? { artifactEngine: true } : {}),
    ...(extended ? { themes: true } : {}),
  });
}
