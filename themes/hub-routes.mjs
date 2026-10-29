import { randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (status, code) => Object.assign(new Error(code), { status, code });
const object = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exact(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw bad(400, 'invalid_request');
}
function publicError(error) {
  if (error?.status) return error;
  if (['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'THEME_EXISTS'].includes(error?.code)) return bad(409, 'conflict');
  if (['THEME_NOT_FOUND', 'THEME_VERSION_NOT_FOUND'].includes(error?.code)) return bad(404, 'not_found');
  return bad(400, 'invalid_request');
}
export function createThemeRoutes({ store, canvasId, projectId, ownerId, onProposal } = {}) {
  if (!store || !ID.test(canvasId ?? '') || !ID.test(projectId ?? '') || !ID.test(ownerId ?? '')) throw new TypeError('theme routes require trusted store and identity');
  const target = Object.freeze({ projectId });
  const route = (method, path, operation, effect, handle) => Object.freeze({ method, path, operation, effect, target, handle: async input => {
    try { return await handle(input); } catch (error) { throw publicError(error); }
  } });
  const write = (path, handle, status = 200) => route('POST', path, 'theme.write', 'write', async input => {
    exact(input.query ?? {}, []); if (input.actor !== ownerId) throw bad(403, 'forbidden');
    return { status, body: await handle(input) };
  });
  const revisionFields = ['expectedWorkspaceRevision', 'idempotencyKey'];
  return [
    route('GET', '/v1/modules/themes', 'theme.read', 'read', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []); return { status: 200, body: store.workspace(canvasId) };
    }),
    write('/v1/modules/themes', async ({ body }) => {
      exact(body, ['id', 'name', 'base', 'tokens', ...revisionFields], ['name', 'base', 'tokens', ...revisionFields]);
      return store.create({ id: body.id ?? randomUUID(), canvasId, origin: 'user', name: body.name, base: body.base, tokens: body.tokens,
        expectedWorkspaceRevision: body.expectedWorkspaceRevision, idempotencyKey: body.idempotencyKey });
    }, 201),
    write('/v1/modules/themes/proposals', async ({ body }) => {
      exact(body, ['name', 'base', 'tokens', 'idempotencyKey', 'origin'], ['name', 'base', 'tokens', 'idempotencyKey', 'origin']);
      exact(body.origin, ['kind', 'sessionId', 'turnId', 'toolCallId'], ['kind', 'sessionId', 'turnId', 'toolCallId']);
      if (body.origin.kind !== 'pi' || ![body.origin.sessionId, body.origin.turnId].every(value => typeof value === 'string' && ID.test(value)) ||
          typeof body.origin.toolCallId !== 'string' || !body.origin.toolCallId.length || body.origin.toolCallId.length > 256 || /[\u0000-\u001f\u007f]/.test(body.origin.toolCallId)) throw bad(400, 'invalid_request');
      const result = { ...store.create({ id: randomUUID(), canvasId, origin: 'agent', name: body.name, base: body.base, tokens: body.tokens, idempotencyKey: body.idempotencyKey }), requestOrigin: body.origin };
      if (onProposal) {
        try { onProposal(result); } catch { return { ...result, eventPublished: false }; }
      }
      return result;
    }, 201),
    write('/v1/modules/themes/:id/versions', async ({ params, body }) => {
      exact(body, ['base', 'tokens', 'expectedVersion', ...revisionFields], ['base', 'tokens', 'expectedVersion', ...revisionFields]);
      return store.append({ themeId: params.id, canvasId, base: body.base, tokens: body.tokens, expectedVersion: body.expectedVersion,
        expectedWorkspaceRevision: body.expectedWorkspaceRevision, idempotencyKey: body.idempotencyKey });
    }, 201),
    write('/v1/modules/themes/:id/activate', async ({ params, body }) => {
      exact(body, ['expectedVersion', ...revisionFields], ['expectedVersion', ...revisionFields]);
      return store.activate({ themeId: params.id, canvasId, expectedVersion: body.expectedVersion,
        expectedWorkspaceRevision: body.expectedWorkspaceRevision, idempotencyKey: body.idempotencyKey });
    }),
    write('/v1/modules/themes/:id/rollback', async ({ params, body }) => {
      exact(body, ['targetVersion', 'expectedVersion', ...revisionFields], ['targetVersion', 'expectedVersion', ...revisionFields]);
      return store.rollback({ themeId: params.id, canvasId, targetVersion: body.targetVersion, expectedVersion: body.expectedVersion,
        expectedWorkspaceRevision: body.expectedWorkspaceRevision, idempotencyKey: body.idempotencyKey });
    }, 201),
    write('/v1/modules/themes/disable', async ({ body }) => {
      exact(body, revisionFields, revisionFields);
      return store.disable({ canvasId, expectedWorkspaceRevision: body.expectedWorkspaceRevision, idempotencyKey: body.idempotencyKey });
    }),
    write('/v1/modules/themes/proposals/:id/reject', async ({ params, body }) => {
      exact(body, ['expectedVersion', 'idempotencyKey'], ['expectedVersion', 'idempotencyKey']);
      return store.reject({ themeId: params.id, expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey });
    }),
  ];
}
