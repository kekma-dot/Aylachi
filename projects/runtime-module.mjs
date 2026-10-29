import { readProjectContextRecord as record, isProjectContextId, isBazaProjectPrefix } from './context-tool.mjs';
import { createProjectContextRoutes, isProjectContextRouteId } from './hub-routes.mjs';

const invalid = () => Object.assign(new Error('PROJECT_CONTEXT_OPTIONS_INVALID'), { code: 'PROJECT_CONTEXT_OPTIONS_INVALID', exitCode: 64 });

export function snapshotProjectBindings(bindings) {
  if (!Array.isArray(bindings) || Object.getPrototypeOf(bindings) !== Array.prototype ||
      bindings.length < 1 || bindings.length > 100 || Reflect.ownKeys(bindings).length !== bindings.length + 1) throw invalid();
  const byCard = new Map(), sessions = new Set(), projects = new Map();
  for (let index = 0; index < bindings.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(bindings, String(index));
    const binding = descriptor && Object.hasOwn(descriptor, 'value') && record(descriptor.value, ['projectId', 'cardId', 'sessionId', 'bazaPrefix']);
    if (!binding || !isProjectContextRouteId(binding.projectId) || ![binding.cardId, binding.sessionId].every(isProjectContextId) ||
        !isBazaProjectPrefix(binding.bazaPrefix) || byCard.has(binding.cardId) || sessions.has(binding.sessionId) ||
        (projects.has(binding.projectId) && projects.get(binding.projectId).bazaPrefix !== binding.bazaPrefix)) throw invalid();
    byCard.set(binding.cardId, Object.freeze({ ...binding }));
    sessions.add(binding.sessionId);
    projects.set(binding.projectId, { projectId: binding.projectId, bazaPrefix: binding.bazaPrefix });
  }
  return Object.freeze([...byCard.values()]);
}

// Trusted startup configuration only; no request/model fields can grant a binding.
export function createBoundProjectContextModule({ config, getStore, ownerId, canvasId }) {
  const options = record(config, ['bindings', 'readProjectContext']);
  if (!options || typeof options.readProjectContext !== 'function') throw invalid();
  const bindings = snapshotProjectBindings(options.bindings);
  const byCard = new Map(bindings.map(binding => [binding.cardId, binding]));
  const projects = new Map(bindings.map(({ projectId, bazaPrefix }) => [projectId, { projectId, bazaPrefix }]));
  let routes;
  try {
    routes = createProjectContextRoutes({
      projects: [...projects.values()], readProjectContext: options.readProjectContext,
      resolveBinding({ actor, projectId, commandId }) {
        if (actor !== ownerId) return null;
        const store = getStore(), command = store.getCommand(commandId);
        if (!command || command.id !== commandId || command.state !== 'RUNNING') return null;
        const binding = byCard.get(command.cardId), card = binding && store.getCard(command.cardId);
        if (!binding || binding.projectId !== projectId || !card || card.id !== binding.cardId ||
            card.canvasId !== canvasId || card.sessionId !== binding.sessionId) return null;
        return { ...binding, commandId };
      },
    });
  } catch { throw invalid(); }
  return Object.freeze({
    bindings, routes,
    validateCards() {
      const store = getStore();
      for (const binding of byCard.values()) {
        const card = store.getCard(binding.cardId);
        if (!card || card.id !== binding.cardId || card.canvasId !== canvasId || card.sessionId !== binding.sessionId) {
          throw Object.assign(new Error('PROJECT_CONTEXT_CARD_NOT_FOUND'), { code: 'PROJECT_CONTEXT_CARD_NOT_FOUND', exitCode: 64 });
        }
      }
    },
  });
}
