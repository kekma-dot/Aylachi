const bad = (status, code) => Object.assign(new Error(code), { status, code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, keys) { if (!plain(value) || Reflect.ownKeys(value).some(key => !keys.includes(key))) throw bad(400, 'invalid_request'); }
function publicError(error) {
  if (error?.status) return error;
  if (['BACKEND_NOT_FOUND', 'ARTIFACT_NOT_FOUND'].includes(error?.code)) return bad(404, 'not_found');
  if (['BACKEND_BINDING_CONFLICT', 'BACKEND_REGISTRY_CLOSED'].includes(error?.code)) return bad(409, 'conflict');
  return bad(400, 'invalid_request');
}

export function createBackendRoutes({ registry, projectId, ownerId } = {}) {
  if (!registry || typeof projectId !== 'string' || typeof ownerId !== 'string') throw new TypeError('backend routes require registry and identity');
  const route = (method, path, handle, effect = 'read') => Object.freeze({ method, path, operation: effect === 'read' ? 'backend.read' : 'backend.write',
    effect, target: Object.freeze({ projectId }), handle: async input => { try { return await handle(input); } catch (error) { throw publicError(error); } } });
  return [
    route('GET', '/v1/modules/backends', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      return { status: 200, body: registry.list() };
    }),
    route('GET', '/v1/modules/backends/health', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      return { status: 200, body: { backends: await registry.health() } };
    }),
    route('GET', '/v1/modules/backends/conversations/:cardId', async ({ params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      const binding = registry.conversation(params.cardId);
      if (!binding) throw bad(404, 'not_found');
      return { status: 200, body: { conversation: binding } };
    }),
    route('POST', '/v1/modules/backends/default', async ({ actor, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, ['backendId']);
      if (actor !== ownerId) throw bad(400, 'invalid_request');
      return { status: 200, body: registry.setDefault(body.backendId) };
    }, 'write'),
  ];
}
