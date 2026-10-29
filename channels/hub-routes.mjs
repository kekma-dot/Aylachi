const bad = (status, code) => Object.assign(new Error(code), { status, code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, allowed, required = []) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw bad(400, 'invalid_request');
}
function publicError(error) {
  if (error?.status) return error;
  if (['CHANNEL_ROUTE_NOT_FOUND', 'CHANNEL_MESSAGE_NOT_FOUND', 'OUTBOUND_NOT_FOUND'].includes(error?.code)) return bad(404, 'not_found');
  if (['CHANNEL_ROUTE_CONFLICT', 'CHANNEL_REVISION_CONFLICT', 'CHANNEL_STATE_CONFLICT', 'CHANNEL_INBOX_CONFLICT',
    'CHANNEL_ROUTE_PAUSED', 'CHANNEL_ROUTE_DETACHED', 'CHANNEL_ADAPTER_UNAVAILABLE', 'OUTBOUND_NOT_RETRYABLE', 'OUTBOUND_STATE_CONFLICT'].includes(error?.code)) return bad(409, 'conflict');
  return bad(400, 'invalid_request');
}

export function createChannelRoutes({ store, plane, projectId, ownerId } = {}) {
  if (!store || !plane || typeof projectId !== 'string' || typeof ownerId !== 'string') throw new TypeError('channel routes require store, plane and identity');
  const route = (method, path, handle, effect = 'read') => Object.freeze({ method, path,
    operation: effect === 'read' ? 'channel.read' : 'channel.write', effect, target: Object.freeze({ projectId }),
    handle: async input => { try { return await handle(input); } catch (error) { throw publicError(error); } } });
  const owner = actor => { if (actor !== ownerId) throw bad(400, 'invalid_request'); };
  return [
    route('POST', '/v1/modules/channels/routes', async ({ actor, query, body }) => {
      owner(actor); exact(query ?? {}, []); exact(body, ['channel', 'accountId', 'chatId', 'threadId', 'conversationId'],
        ['channel', 'accountId', 'chatId', 'threadId', 'conversationId']);
      return { status: 201, body: store.bind(body) };
    }, 'write'),
    route('GET', '/v1/modules/channels/routes', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []); return { status: 200, body: { routes: store.routes() } };
    }),
    route('POST', '/v1/modules/channels/routes/:id', async ({ actor, params, query, body }) => {
      owner(actor); exact(query ?? {}, []); exact(body, ['expectedRevision', 'action'], ['expectedRevision', 'action']);
      return { status: 200, body: { route: store.updateRoute(params.id, body.expectedRevision, body.action) } };
    }, 'write'),
    route('POST', '/v1/modules/channels/inbox', async ({ actor, query, body }) => {
      owner(actor); exact(query ?? {}, []); exact(body, ['routeId', 'externalMessageId', 'actingPrincipal', 'text'],
        ['routeId', 'externalMessageId', 'actingPrincipal', 'text']);
      return { status: 201, body: await plane.ingest(body.routeId, body) };
    }, 'write'),
    route('GET', '/v1/modules/channels/inbox/:id', async ({ params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      const message = store.inbox(params.id); if (!message) throw bad(404, 'not_found');
      return { status: 200, body: { message } };
    }),
    route('GET', '/v1/modules/channels/outbox', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []); return { status: 200, body: { messages: store.outbound() } };
    }),
    route('POST', '/v1/modules/channels/outbox/flush', async ({ actor, query, body }) => {
      owner(actor); exact(query ?? {}, []); exact(body ?? {}, []);
      return { status: 200, body: { messages: await plane.flush() } };
    }, 'write'),
  ];
}
