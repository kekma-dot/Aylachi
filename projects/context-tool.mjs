const OPERATION = 'project.context.read';
const PERMISSION = 'read';
const MAX_QUERY_CHARS = 200;
const MAX_EXCERPTS = 10;
const MAX_REPLY_BYTES = 32 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BAZA_ROOT = '10 Проекты/';

function recordValues(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || keys.some(key => !ownKeys.includes(key))) return null;
    const values = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    return null;
  }
}

function validId(value) {
  return typeof value === 'string' && ID.test(value);
}

const hasControl = value => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function validPrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.startsWith(BAZA_ROOT) || !prefix.endsWith('/') || prefix.includes('\\') || hasControl(prefix)) return false;
  const segments = prefix.slice(0, -1).split('/');
  return segments.length === 2 && segments[0] === '10 Проекты' &&
    segments[1] !== '' && segments[1] !== '.' && segments[1] !== '..' && !segments[1].startsWith('.');
}

function readBinding(value) {
  const binding = recordValues(value, ['projectId', 'cardId', 'sessionId', 'commandId', 'bazaPrefix']);
  if (!binding || !validId(binding.projectId) || !validId(binding.cardId) ||
      !validId(binding.sessionId) || !validId(binding.commandId) || !validPrefix(binding.bazaPrefix)) return null;
  return binding;
}

function readArgs(value) {
  const args = recordValues(value, ['query']);
  if (!args || typeof args.query !== 'string' || !args.query.trim() ||
      Array.from(args.query).length > MAX_QUERY_CHARS) return null;
  return args.query;
}

function readExcerptArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_EXCERPTS) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) return null;
    const excerpts = [];
    for (let index = 0; index < value.length; index++) {
      if (!keys.includes(String(index))) return null;
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item || item.enumerable !== true || !Object.hasOwn(item, 'value')) return null;
      const excerpt = recordValues(item.value, ['path', 'text']);
      if (!excerpt || typeof excerpt.path !== 'string' || typeof excerpt.text !== 'string') return null;
      excerpts.push({ path: excerpt.path, text: excerpt.text });
    }
    return excerpts;
  } catch {
    return null;
  }
}

function validPath(path, prefix) {
  if (typeof path !== 'string' || path.length > 1024 || path.includes('\\') || hasControl(path) || path.startsWith('/') ||
      !path.endsWith('.md') || !path.startsWith(prefix)) return false;
  const segments = path.split('/');
  return segments.length > 2 && segments.every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.'));
}

function validateReply(value, binding) {
  const reply = recordValues(value, ['projectId', 'excerpts']);
  if (!reply || reply.projectId !== binding.projectId) return null;
  const excerpts = readExcerptArray(reply.excerpts);
  if (!excerpts || excerpts.some(item => !validPath(item.path, binding.bazaPrefix))) return null;
  const result = { projectId: reply.projectId, excerpts };
  let rawBytes = Buffer.byteLength(result.projectId);
  for (const excerpt of excerpts) {
    rawBytes += Buffer.byteLength(excerpt.path) + Buffer.byteLength(excerpt.text);
    if (rawBytes > MAX_REPLY_BYTES) return null;
  }
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded) > MAX_REPLY_BYTES) return null;
  return { result, encoded };
}

export {
  recordValues as readProjectContextRecord,
  validId as isProjectContextId,
  validPrefix as isBazaProjectPrefix,
  readBinding as parseProjectContextBinding,
  readArgs as parseProjectContextQuery,
  validateReply as validateProjectContextReply,
};

export function createProjectContextTool({ Type, getBinding, authorize, readProjectContext } = {}) {
  if (typeof Type?.Object !== 'function' || typeof Type?.String !== 'function' ||
      typeof getBinding !== 'function' || typeof authorize !== 'function' || typeof readProjectContext !== 'function') {
    throw new TypeError('EXPLICIT_PROJECT_CONTEXT_BINDING_REQUIRED');
  }

  return {
    name: 'project_context',
    label: 'Project context',
    description: 'Read bounded, authorized excerpts from this session’s bound project context.',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: MAX_QUERY_CHARS }) }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const query = readArgs(params);
      if (query === null || typeof toolCallId !== 'string' || !toolCallId || Buffer.byteLength(toolCallId) > 1024) {
        throw new Error('INVALID_INPUT');
      }

      let binding;
      try { binding = readBinding(await getBinding(toolCallId)); }
      catch { throw new Error('PROJECT_BINDING_FAILED'); }
      if (!binding) throw new Error('PROJECT_BINDING_FAILED');

      const descriptor = Object.freeze({
        operation: OPERATION,
        permission: PERMISSION,
        target: Object.freeze({ projectId: binding.projectId, cardId: binding.cardId, sessionId: binding.sessionId }),
        commandId: binding.commandId,
      });
      let allowed;
      try { allowed = await authorize(descriptor); }
      catch { throw new Error('AUTHORIZATION_FAILED'); }
      if (allowed !== true) throw new Error('POLICY_DENIED');

      let response;
      try { response = await readProjectContext(binding.projectId, query, signal); }
      catch { throw new Error('CONTEXT_UNAVAILABLE'); }
      const validated = validateReply(response, binding);
      if (!validated) throw new Error('INVALID_CONTEXT_RESPONSE');
      return { content: [{ type: 'text', text: validated.encoded }] };
    },
  };
}
