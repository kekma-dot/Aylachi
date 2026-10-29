const bad = (status, code) => Object.assign(new Error(code), { status, code });
const object = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exact(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw bad(400, 'invalid_request');
}
function publicError(error) {
  if (error?.status) return error;
  if (['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'LOCAL_BROWSER_CONTROLS_NAVIGATION'].includes(error?.code)) return bad(409, 'conflict');
  if (['BROWSER_SESSION_NOT_FOUND', 'BROWSER_TAB_NOT_FOUND', 'BROWSER_BACKEND_UNAVAILABLE'].includes(error?.code)) return bad(404, 'not_found');
  if (['BROWSER_URL_DENIED'].includes(error?.code)) return bad(403, 'forbidden');
  if (['BROWSER_HTTP_ERROR', 'BROWSER_CONTENT_LIMIT', 'BROWSER_CONTENT_TYPE_DENIED', 'BROWSER_REDIRECT_LIMIT'].includes(error?.code)) return bad(502, 'browser_backend_error');
  return bad(400, 'invalid_request');
}
export function createBrowserRoutes({ browsers, canvasId, projectId, ownerId } = {}) {
  if (!browsers || !canvasId || !projectId || !ownerId) throw new TypeError('browser routes require trusted composition');
  const target = Object.freeze({ projectId });
  const route = (method, path, operation, effect, handle) => Object.freeze({ method, path, operation, effect, target, handle: async input => {
    try { return await handle(input); } catch (error) { throw publicError(error); }
  } });
  const write = (path, operation, handle) => route('POST', path, operation, 'write', async input => {
    exact(input.query ?? {}, []); if (input.actor !== ownerId) throw bad(403, 'forbidden');
    const result = await handle(input); return { status: 200, body: result };
  });
  const session = input => {
    const current = browsers.current({ kind: 'browser', refId: input.params.id });
    if (current.session.canvasId !== canvasId) throw bad(404, 'not_found');
    return current;
  };
  return [
    route('GET', '/v1/modules/browser/health', 'browser.read', 'read', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []); return { status: 200, body: { backends: browsers.health() } };
    }),
    route('GET', '/v1/modules/browser/sessions/:id', 'browser.read', 'read', async input => {
      exact(input.query ?? {}, []); exact(input.body ?? {}, []); return { status: 200, body: session(input) };
    }),
    write('/v1/modules/browser/sessions/:id/tabs', 'browser.write', async input => {
      exact(input.body, ['expectedRevision', 'url', 'idempotencyKey'], ['expectedRevision', 'url', 'idempotencyKey']); session(input);
      return browsers.openTab({ sessionId: input.params.id, ...input.body, signal: input.signal });
    }),
    write('/v1/modules/browser/sessions/:id/navigation', 'browser.write', async input => {
      exact(input.body, ['expectedRevision', 'url', 'idempotencyKey'], ['expectedRevision', 'url', 'idempotencyKey']); session(input);
      return browsers.navigate({ sessionId: input.params.id, ...input.body, signal: input.signal });
    }),
    write('/v1/modules/browser/sessions/:id/snapshots', 'browser.write', async input => {
      exact(input.body, ['expectedRevision', 'idempotencyKey'], ['expectedRevision', 'idempotencyKey']); session(input);
      return browsers.refresh({ sessionId: input.params.id, ...input.body, signal: input.signal });
    }),
    write('/v1/modules/browser/sessions/:id/active-tab', 'browser.write', async input => {
      exact(input.body, ['tabId', 'expectedRevision', 'idempotencyKey'], ['tabId', 'expectedRevision', 'idempotencyKey']); session(input);
      return browsers.activate({ sessionId: input.params.id, ...input.body });
    }),
  ];
}
