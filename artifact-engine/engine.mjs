import { createHash } from 'node:crypto';
import { builtinRenderers } from './renderers.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value, code = 'INVALID_ID') => { if (typeof value !== 'string' || !ID.test(value)) throw bad(code); return value; };
const versionNumber = value => { if (!Number.isSafeInteger(value) || value < 1) throw bad('INVALID_VERSION'); return value; };

function sources(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 16) throw bad('INVALID_SOURCES');
  return value.map((source, index) => {
    if (!plain(source) || Reflect.ownKeys(source).some(key => !['uri', 'label', 'snapshot'].includes(key)) ||
        typeof source.uri !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(source.uri) || /[\u0000-\u0020]/.test(source.uri) || source.uri.length > 2048 ||
        (source.label !== undefined && (typeof source.label !== 'string' || !source.label.trim() || source.label.length > 120)) ||
        typeof source.snapshot !== 'string' || Buffer.byteLength(source.snapshot) > 32 * 1024) throw bad('INVALID_SOURCES');
    return { uri: source.uri, label: source.label?.trim() || `Source ${index + 1}`, snapshot: source.snapshot, sha256: hash(source.snapshot) };
  });
}
function origin(value) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !['kind', 'sessionId', 'turnId', 'toolCallId', 'nodeId'].includes(key)) ||
      !['pi', 'aylachi', 'api'].includes(value.kind)) throw bad('INVALID_ORIGIN');
  const result = {};
  for (const key of ['kind', 'sessionId', 'turnId', 'nodeId']) {
    if (value[key] !== undefined) result[key] = id(value[key], 'INVALID_ORIGIN');
  }
  if (value.toolCallId !== undefined) {
    if (typeof value.toolCallId !== 'string' || !value.toolCallId || value.toolCallId.length > 256 || /[\u0000-\u001f]/.test(value.toolCallId)) throw bad('INVALID_ORIGIN');
    result.toolCallId = value.toolCallId;
  }
  return result;
}
function text(input) {
  if (!plain(input) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 ||
      typeof input.content !== 'string' || typeof input.format !== 'string') throw bad('INVALID_ARTIFACT');
  return { title: input.title.trim(), format: input.format, content: input.content, sources: sources(input.sources), origin: origin(input.origin) };
}
function requestHash(operation, input) { return hash(JSON.stringify({ operation, ...input })); }

export function createArtifactEngine({ store, renderers = builtinRenderers } = {}) {
  if (!store || !['get', 'list', 'versions', 'create', 'append', 'rollback'].every(key => typeof store[key] === 'function')) throw new TypeError('artifact store required');
  if (!plain(renderers)) throw new TypeError('renderer registry required');
  const normalize = input => {
    const result = text(input);
    const renderer = renderers[result.format];
    if (!renderer || typeof renderer.validate !== 'function' || typeof renderer.export !== 'function') throw bad('UNSUPPORTED_FORMAT');
    renderer.validate(result.content);
    if (Buffer.byteLength(JSON.stringify(result.sources)) > 80 * 1024) throw bad('INVALID_SOURCES');
    return { ...result, contentHash: hash(result.content) };
  };
  return Object.freeze({
    create(input) {
      const key = id(input?.idempotencyKey, 'INVALID_IDEMPOTENCY_KEY');
      const artifactId = id(input?.artifactId ?? `artifact-${hash(key)}`);
      const normalized = normalize(input);
      return store.create({ ...normalized, artifactId, idempotencyKey: key, requestHash: requestHash('create', { artifactId, ...normalized }) });
    },
    update(input) {
      const artifactId = id(input?.artifactId), expectedVersion = versionNumber(input?.expectedVersion);
      const normalized = normalize(input), key = id(input?.idempotencyKey, 'INVALID_IDEMPOTENCY_KEY');
      return store.append({ ...normalized, artifactId, expectedVersion, idempotencyKey: key,
        requestHash: requestHash('append', { artifactId, expectedVersion, ...normalized }) });
    },
    rollback({ artifactId, targetVersion, idempotencyKey, origin: sourceOrigin } = {}) {
      const normalized = { artifactId: id(artifactId), targetVersion: versionNumber(targetVersion), origin: origin(sourceOrigin) };
      return store.rollback({ ...normalized, idempotencyKey: id(idempotencyKey, 'INVALID_IDEMPOTENCY_KEY'), requestHash: requestHash('rollback', normalized) });
    },
    get(artifactId, version) { return store.get(id(artifactId), version === undefined ? undefined : versionNumber(version)); },
    list() { return store.list(100); },
    versions(artifactId) { return store.versions(id(artifactId)); },
    export(artifactId, version) {
      const result = store.get(id(artifactId), version === undefined ? undefined : versionNumber(version));
      const renderer = renderers[result.version.format];
      if (!renderer) throw bad('UNSUPPORTED_FORMAT');
      const exported = renderer.export({ title: result.version.title, content: result.version.content });
      return { ...result, ...exported, contentHash: result.version.contentHash,
        manifest: { schemaVersion: 1, artifactId: result.artifact.id, version: result.version.version,
          contentHash: result.version.contentHash, sources: result.version.sources } };
    },
  });
}
