import { createProjectContextTool, parseProjectContextBinding, readProjectContextRecord } from '../projects/context-tool.mjs';
import { createHubClient } from '../hub/client.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPTION_KEYS = new Set(['Type', 'connection', 'getSessionBinding', 'fetch', 'timeoutMs']);

function dataRecord(value, keys, exact = true) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(value);
    if ((exact && own.length !== keys.length) || keys.some(key => !own.includes(key))) return null;
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}

function snapshotOptions(options) {
  try {
    const keys = Reflect.ownKeys(options);
    if (keys.some(key => typeof key !== 'string' || !OPTION_KEYS.has(key))) return null;
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}

function snapshotConnection(value) {
  const fields = dataRecord(value, ['baseUrl', 'bearer']);
  if (!fields || typeof fields.baseUrl !== 'string' || typeof fields.bearer !== 'string' ||
      !/^[\x21-\x7e]{32,4096}$/.test(fields.bearer)) return null;
  try {
    const url = new URL(fields.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  } catch { return null; }
  return Object.freeze({ baseUrl: fields.baseUrl, bearer: fields.bearer });
}

function snapshotBinding(value, sessionId) {
  const fields = readProjectContextRecord(value, ['projectId', 'cardId', 'sessionId', 'bazaPrefix']);
  if (!fields || fields.sessionId !== sessionId) return null;
  const parsed = parseProjectContextBinding({ ...fields, commandId: 'snapshot-command' });
  if (!parsed) return null;
  return Object.freeze({ projectId: parsed.projectId, cardId: parsed.cardId, sessionId: parsed.sessionId, bazaPrefix: parsed.bazaPrefix });
}

function readBinding(getSessionBinding, sessionId) {
  try { return snapshotBinding(getSessionBinding(sessionId), sessionId); }
  catch { return null; }
}

function snapshotTurn(getTurnContext, selectedSessionId) {
  let context;
  try { context = getTurnContext(); } catch { return null; }
  const fields = dataRecord(context, ['sessionId', 'turnId']);
  if (!Object.isFrozen(context) || !fields || fields.sessionId !== selectedSessionId ||
      !SESSION_ID.test(fields.sessionId) || typeof fields.turnId !== 'string' || !TURN_ID.test(fields.turnId)) return null;
  return Object.freeze({ sessionId: fields.sessionId, turnId: fields.turnId });
}

function snapshotSelection(selection) {
  const fields = dataRecord(selection, ['sessionId', 'getTurnContext'], false);
  if (!fields || typeof fields.sessionId !== 'string' || !SESSION_ID.test(fields.sessionId) || typeof fields.getTurnContext !== 'function') return null;
  return Object.freeze({ sessionId: fields.sessionId, getTurnContext: fields.getTurnContext });
}

function sameBinding(left, right) {
  return left?.projectId === right?.projectId && left?.cardId === right?.cardId &&
    left?.sessionId === right?.sessionId && left?.bazaPrefix === right?.bazaPrefix;
}

export function createRuntimeProjectContextToolFactory(options = {}) {
  const values = snapshotOptions(options);
  if (!values || !values.connection || typeof values.getSessionBinding !== 'function') return () => [];
  const connection = snapshotConnection(values.connection);
  if (!connection || typeof values.Type?.Object !== 'function' || typeof values.Type?.String !== 'function') return () => [];
  const fetchImpl = values.fetch ?? globalThis.fetch;
  const timeoutMs = values.timeoutMs ?? 5000;
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return () => [];
  const Type = values.Type;
  const getSessionBinding = values.getSessionBinding;

  return function toolDefinitionsFactory(selection) {
    const selected = snapshotSelection(selection);
    if (!selected) return [];
    const binding = readBinding(getSessionBinding, selected.sessionId);
    if (!binding) return [];

    return [Object.freeze({ name: 'project_context', label: 'Project context',
      description: 'Read bounded, authorized excerpts from this session’s bound project context.',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
      async execute(toolCallId, params, signal) {
        const turn = snapshotTurn(selected.getTurnContext, selected.sessionId);
        if (!turn || typeof toolCallId !== 'string' || !toolCallId) throw new Error('PROJECT_BINDING_FAILED');
        const tool = createProjectContextTool({
          Type,
          getBinding: async () => Object.freeze({ ...binding, commandId: turn.turnId }),
          authorize: async descriptor => {
            const before = snapshotTurn(selected.getTurnContext, selected.sessionId);
            const currentBinding = readBinding(getSessionBinding, selected.sessionId);
            const after = snapshotTurn(selected.getTurnContext, selected.sessionId);
            return descriptor.commandId === turn.turnId && before?.turnId === turn.turnId &&
              sameBinding(binding, currentBinding) && after?.turnId === turn.turnId;
          },
          readProjectContext: async (projectId, query, requestSignal) => {
            const before = snapshotTurn(selected.getTurnContext, selected.sessionId);
            const currentBinding = readBinding(getSessionBinding, selected.sessionId);
            const after = snapshotTurn(selected.getTurnContext, selected.sessionId);
            if (projectId !== binding.projectId || before?.turnId !== turn.turnId ||
                !sameBinding(binding, currentBinding) || after?.turnId !== turn.turnId) throw new Error('BINDING');
            const client = createHubClient({ ...connection, fetch: fetchImpl, timeoutMs });
            return client.moduleRequest({ method: 'POST', path: `/v1/modules/projects/${encodeURIComponent(projectId)}/context`,
              body: { commandId: turn.turnId, query }, signal: requestSignal });
          },
        });
        return tool.execute(toolCallId, params, signal);
      } })];
  };
}
