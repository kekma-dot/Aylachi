const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (status, code) => Object.assign(new Error(code), { status, code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, allowed, required = []) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw bad(400, 'invalid_request');
}
function publicError(error) {
  if (error?.status) return error;
  if (['IDEMPOTENCY_CONFLICT', 'VERSION_CONFLICT', 'ARTIFACT_EXISTS', 'ARTIFACT_NODE_CONFLICT', 'REVISION_CONFLICT'].includes(error?.code)) return bad(409, 'conflict');
  if (['ARTIFACT_NOT_FOUND', 'ARTIFACT_VERSION_NOT_FOUND', 'NODE_NOT_FOUND'].includes(error?.code)) return bad(404, 'not_found');
  return bad(400, 'invalid_request');
}

export function createArtifactRoutes({ engine, adapter, graph, projectId, canvasId, ownerId, onVersion } = {}) {
  if (!engine || !adapter || !graph || !ID.test(projectId ?? '') || !ID.test(canvasId ?? '') || !ID.test(ownerId ?? '')) throw new TypeError('artifact routes require trusted stores and identity');
  const route = (method, path, operation, effect, handle) => Object.freeze({ method, path, operation, effect, target: Object.freeze({ projectId }),
    handle: async input => { try { return await handle(input); } catch (error) { throw publicError(error); } } });
  const nodeFor = artifactId => {
    const node = graph.getNode(adapter.nodeIdFor(artifactId));
    if (!node || node.canvasId !== canvasId || node.refId !== artifactId) throw bad(404, 'not_found');
    return node;
  };
  const publish = result => {
    if (!result.version.origin.turnId) return result;
    try { onVersion?.(result); return { ...result, eventPublished: true }; }
    catch { return { ...result, eventPublished: false }; } // Exact committed content must not become a false tool failure.
  };
  const versionQuery = query => {
    exact(query ?? {}, ['version']);
    if (query.version === undefined) return undefined;
    if (typeof query.version !== 'string' || !/^[1-9]\d{0,8}$/.test(query.version)) throw bad(400, 'invalid_request');
    return Number(query.version);
  };
  const base = '/v1/modules/artifacts';
  return [
    route('GET', base, 'artifact.read', 'read', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      return { status: 200, body: { artifacts: engine.list() } };
    }),
    route('POST', base, 'artifact.write', 'write', async ({ actor, query, body }) => {
      exact(query ?? {}, []); exact(body, ['idempotencyKey', 'title', 'format', 'content', 'sources', 'origin', 'layout'],
        ['idempotencyKey', 'title', 'format', 'content', 'sources', 'origin']);
      if (actor !== ownerId || (body.layout !== undefined && !plain(body.layout))) throw bad(400, 'invalid_request');
      return { status: 201, body: publish(adapter.create(body)) };
    }),
    route('GET', `${base}/:id`, 'artifact.read', 'read', async ({ params, query, body }) => {
      exact(body ?? {}, []); const version = versionQuery(query); nodeFor(params.id);
      return { status: 200, body: { ...engine.get(params.id, version), node: nodeFor(params.id) } };
    }),
    route('GET', `${base}/:id/versions`, 'artifact.read', 'read', async ({ params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []); nodeFor(params.id);
      return { status: 200, body: { versions: engine.versions(params.id) } };
    }),
    route('GET', `${base}/:id/export`, 'artifact.read', 'read', async ({ params, query, body }) => {
      exact(body ?? {}, []); const version = versionQuery(query); nodeFor(params.id);
      return { status: 200, body: engine.export(params.id, version) };
    }),
    route('POST', `${base}/:id/rollback`, 'artifact.write', 'write', async ({ actor, params, query, body }) => {
      exact(query ?? {}, []); exact(body, ['targetVersion', 'expectedRevision', 'idempotencyKey'], ['targetVersion', 'expectedRevision', 'idempotencyKey']);
      if (actor !== ownerId) throw bad(400, 'invalid_request');
      return { status: 200, body: publish(adapter.rollback(nodeFor(params.id), body.expectedRevision, body.targetVersion, body.idempotencyKey)) };
    }),
  ];
}
