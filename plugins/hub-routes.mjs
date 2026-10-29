const bad = (status, code) => Object.assign(new Error(code), { status, code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => { if (!plain(value) || Reflect.ownKeys(value).some(key => !keys.includes(key))) throw bad(400, 'invalid_request'); };
const publicError = error => error?.status ? error : error?.code === 'PLUGIN_NOT_FOUND' ? bad(404, 'not_found') : bad(400, 'invalid_request');

export function createPluginRoutes({ plane, projectId, ownerId } = {}) {
  if (!plane || typeof projectId !== 'string' || typeof ownerId !== 'string') throw new TypeError('plugin routes require plane and identity');
  const route = (method, path, effect, handle) => Object.freeze({ method, path, operation: effect === 'read' ? 'plugin.read' : 'plugin.write', effect,
    target: Object.freeze({ projectId }), handle: async input => { try { return await handle(input); } catch (error) { throw publicError(error); } } });
  return [
    route('GET', '/v1/modules/plugins', 'read', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      return { status: 200, body: { plugins: plane.list() } };
    }),
    route('GET', '/v1/modules/plugins/:id/health', 'read', async ({ params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      return { status: 200, body: { health: await plane.health(params.id) } };
    }),
    route('POST', '/v1/modules/plugins/:id', 'write', async ({ actor, params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, ['action']);
      if (actor !== ownerId || !['activate', 'disable'].includes(body.action)) throw bad(400, 'invalid_request');
      const result = body.action === 'activate' ? await plane.activate(params.id) : await plane.disable(params.id);
      return { status: 200, body: { plugin: result } };
    }),
  ];
}
