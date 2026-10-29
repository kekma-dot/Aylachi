const bad = (status, code) => Object.assign(new Error(code), { status, code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, allowed, required = []) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw bad(400, 'invalid_request');
}
function publicError(error) {
  if (error?.status) return error;
  if (error?.code === 'MEMORY_PROPOSAL_NOT_FOUND') return bad(404, 'not_found');
  if (['MEMORY_REQUEST_CONFLICT', 'MEMORY_REVIEW_CONFLICT', 'MEMORY_STATE_CONFLICT', 'MEMORY_REVIEWER_REQUIRED',
    'MEMORY_PROMOTION_NOT_APPROVED', 'MEMORY_PROMOTION_UNAVAILABLE', 'MEMORY_PROMOTION_DENIED', 'MEMORY_PROMOTION_CONFLICT'].includes(error?.code)) return bad(409, 'conflict');
  return bad(400, 'invalid_request');
}

// Promotion is deliberately absent: only trusted composition can call plane.promote().
export function createMemoryRoutes({ store, projectId } = {}) {
  if (!store || typeof projectId !== 'string') throw new TypeError('memory routes require store and project');
  const route = (method, path, handle, effect = 'read') => Object.freeze({ method, path,
    operation: effect === 'read' ? 'memory.read' : 'memory.write', effect, target: Object.freeze({ projectId }),
    handle: async input => { try { return await handle(input); } catch (error) { throw publicError(error); } } });
  return [
    route('POST', '/v1/modules/memory/proposals', async ({ actor, query, body }) => {
      exact(query ?? {}, []); exact(body, ['requestId', 'targetId', 'baseRevision', 'content', 'worktree', 'branch'],
        ['requestId', 'targetId', 'baseRevision', 'content', 'worktree', 'branch']);
      return { status: 201, body: store.propose({ ...body, owner: actor }) };
    }, 'write'),
    route('GET', '/v1/modules/memory/proposals', async ({ query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []); return { status: 200, body: { proposals: store.list() } };
    }),
    route('GET', '/v1/modules/memory/proposals/:id', async ({ params, query, body }) => {
      exact(query ?? {}, []); exact(body ?? {}, []);
      const proposal = store.get(params.id); if (!proposal) throw bad(404, 'not_found');
      return { status: 200, body: { proposal } };
    }),
    route('POST', '/v1/modules/memory/proposals/:id/review', async ({ actor, params, query, body }) => {
      exact(query ?? {}, []); exact(body, ['expectedRevision', 'decision', 'note'], ['expectedRevision', 'decision']);
      return { status: 200, body: { proposal: store.review(params.id, { ...body, reviewer: actor }) } };
    }, 'write'),
  ];
}
