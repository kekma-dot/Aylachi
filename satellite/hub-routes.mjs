import { bad, exact, id, plain, requireHash } from './protocol.mjs';

function mapped(error) {
  if (['NOT_FOUND', 'SATELLITE_NOT_FOUND'].includes(error?.code)) return bad('not_found', 404);
  if (['REQUEST_ID_CONFLICT', 'EFFECT_CONFLICT', 'SATELLITE_OFFLINE'].includes(error?.code)) return bad('conflict', 409);
  if (['CONNECTOR_NOT_APPROVED', 'SATELLITE_REVOKED'].includes(error?.code)) return bad('forbidden', 403);
  if (error?.status === 413 || error?.code === 'TOO_LARGE') return bad('payload_too_large', 413);
  if (error?.status === 400 || ['INVALID_REQUEST', 'INVALID_MANIFEST', 'INVALID_JSON'].includes(error?.code)) return bad('invalid_request', 400);
  return bad('internal_error', 500);
}
const safe = handler => async input => { try { return await handler(input); } catch (error) { throw mapped(error); } };

export function createConnectorRoutes({ plane, projectId, ownerId } = {}) {
  if (!plane || typeof projectId !== 'string' || typeof ownerId !== 'string') throw new TypeError('connector routes require plane and identity');
  const target = Object.freeze({ projectId });
  const route = (method, path, effect, handle) => Object.freeze({ method, path,
    operation: effect === 'read' ? 'connector.read' : 'connector.write', effect, target, handle: safe(handle) });
  return [
    route('GET', '/v1/modules/connectors', 'read', async ({ query, body, actor }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      return { status: 200, body: { ...plane.catalog(), commands: plane.list({ actor }) } };
    }),
    route('GET', '/v1/modules/connectors/events', 'read', async ({ actor, query, body }) => {
      exact(body ?? {}, []); exact(query ?? {}, [], ['after', 'limit']);
      const after = query.after === undefined ? 0 : Number(query.after), limit = query.limit === undefined ? 100 : Number(query.limit);
      const events = plane.events({ actor, after, limit });
      return { status: 200, body: { events, nextSequence: events.at(-1)?.sequence ?? after } };
    }),
    route('GET', '/v1/modules/connectors/commands/:id', 'read', async ({ actor, params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      return { status: 200, body: { command: plane.get({ actor, commandId: params.id }) } };
    }),
    route('POST', '/v1/modules/connectors/tools/:name', 'write', async ({ actor, params, query, body, requestId }) => {
      exact(query ?? {}, []); exact(body ?? {}, ['requestId', 'payload']);
      if (!plain(body.payload)) throw bad('invalid_request', 400);
      const result = plane.invoke({ actor, requestId, toolName: params.name, payload: body.payload });
      return { status: result.duplicate ? 200 : 201, body: result };
    }),
    route('POST', '/v1/modules/connectors/commands/:id', 'write', async ({ actor, params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, ['action', 'expectedPayloadHash']);
      if (actor !== ownerId || !['approve', 'reject'].includes(body.action)) throw bad('invalid_request', 400);
      requireHash(body.expectedPayloadHash);
      return { status: 200, body: { command: plane.approve({ actor, commandId: params.id,
        expectedPayloadHash: body.expectedPayloadHash, action: body.action }) } };
    }),
    route('POST', '/v1/modules/connectors/satellites/:id', 'write', async ({ actor, params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, ['action']);
      if (actor !== ownerId || body.action !== 'revoke') throw bad('invalid_request', 400);
      return { status: 200, body: { satellite: plane.revoke({ satelliteId: params.id }) } };
    }),
  ];
}
