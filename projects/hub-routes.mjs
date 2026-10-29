import {
  readProjectContextRecord as record, isProjectContextId, isBazaProjectPrefix,
  parseProjectContextBinding, parseProjectContextQuery, validateProjectContextReply,
} from './context-tool.mjs';

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isProjectContextRouteId = value => isProjectContextId(value) && SLUG.test(value);
const fail = (status, code) => Object.assign(new Error(code), { status, code });

export function createProjectContextRoutes({ projects, resolveBinding, readProjectContext } = {}) {
  if (!Array.isArray(projects) || Object.getPrototypeOf(projects) !== Array.prototype || projects.length > 100 ||
      Reflect.ownKeys(projects).length !== projects.length + 1 ||
      typeof resolveBinding !== 'function' || typeof readProjectContext !== 'function') throw new TypeError('INVALID_PROJECT_CONTEXT_CONFIG');
  const ids = new Set(), selected = [];
  for (let index = 0; index < projects.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(projects, String(index));
    const project = descriptor && Object.hasOwn(descriptor, 'value') && record(descriptor.value, ['projectId', 'bazaPrefix']);
    if (!project || !isProjectContextRouteId(project.projectId) ||
        !isBazaProjectPrefix(project.bazaPrefix) || ids.has(project.projectId)) throw new TypeError('INVALID_PROJECT_CONTEXT_CONFIG');
    ids.add(project.projectId);
    selected.push(Object.freeze({ ...project }));
  }
  return Object.freeze(selected.map(project => Object.freeze({
    method: 'POST', path: `/v1/modules/projects/${project.projectId}/context`,
    operation: 'project.context.read', effect: 'read', target: Object.freeze({ projectId: project.projectId }),
    async handle({ actor, body, params = {}, query = {} }) {
      const input = record(body, ['commandId', 'query']);
      const requestQuery = input && parseProjectContextQuery({ query: input.query });
      if (!record(params, []) || !record(query, []) || !input || !isProjectContextId(input.commandId) || requestQuery === null) throw fail(400, 'invalid_request');
      let binding;
      try { binding = parseProjectContextBinding(await resolveBinding({ actor, projectId: project.projectId, commandId: input.commandId })); }
      catch { throw fail(404, 'not_found'); }
      if (!binding || binding.projectId !== project.projectId || binding.bazaPrefix !== project.bazaPrefix || binding.commandId !== input.commandId) throw fail(404, 'not_found');
      let reply;
      try { reply = validateProjectContextReply(await readProjectContext(project.projectId, requestQuery, AbortSignal.timeout(5000)), binding); }
      catch { throw fail(500, 'context_unavailable'); }
      if (!reply) throw fail(500, 'context_unavailable');
      return { status: 200, body: reply.result };
    },
  })));
}
