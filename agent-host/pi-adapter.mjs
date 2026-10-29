import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
const resourceLoaderMethods = ['getExtensions', 'getSkills', 'getPrompts', 'getThemes', 'getAgentsFiles', 'getSystemPrompt', 'getSystemPromptSource', 'getAppendSystemPrompt', 'getAppendSystemPromptSources', 'extendResources', 'reload'];
const isResourceLoader = value => value !== null && typeof value === 'object' && resourceLoaderMethods.every(method => typeof value[method] === 'function');
const RESTORED_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i;
const restoredUuid = basename => basename.slice(-42, -'.jsonl'.length);
export function snapshotRestoredSessionFiles(value) {
  if (value === undefined) return undefined;
  if (typeof process.getuid !== 'function') throw new Error('RESTORED_SESSION_UNSUPPORTED_PLATFORM');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid restoredSessionFiles');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid restoredSessionFiles');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 100 || keys.some(key => typeof key !== 'string' || !validId(key) || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new TypeError('invalid restoredSessionFiles');
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !RESTORED_FILE.test(descriptor.value)) throw new TypeError('invalid restoredSessionFiles');
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
async function checkedRestoredSessionFile(root, id, basename) {
  const sessions = join(root, 'sessions');
  const directory = join(sessions, id);
  const file = join(directory, basename);
  try {
    for (const path of [root, sessions, directory]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== path) throw new Error('RESTORED_SESSION_INVALID');
    }
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || await realpath(file) !== file) throw new Error('RESTORED_SESSION_INVALID');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('RESTORED_SESSION_MISSING');
    throw error;
  }
  return { directory, file };
}
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9][A-Za-z0-9_-]{0,63}__[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function snapshotToolDefinitions(value, allowSelectors) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('toolDefinitionsFactory must return an array; plain arrays only');
  const keys = Reflect.ownKeys(value), length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1 || !keys.includes('length')) throw new TypeError('tool definitions must be a dense plain array');
  const tools = [], names = new Set();
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('tool definitions must contain own data values');
    const tool = descriptor.value;
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new TypeError('invalid tool definition');
    const prototype = Object.getPrototypeOf(tool), ownKeys = Reflect.ownKeys(tool);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('tool definitions must be plain objects');
    const fields = new Map();
    for (const key of ownKeys) {
      const field = Object.getOwnPropertyDescriptor(tool, key);
      if (typeof key !== 'string' || !field?.enumerable || !Object.hasOwn(field, 'value')) throw new TypeError('tool definitions must use own data properties');
      fields.set(key, field.value);
    }
    const name = fields.get('name');
    const selector = fields.size === 1 && fields.has('name');
    if (selector) {
      if (!allowSelectors || typeof name !== 'string' || !MCP_TOOL_NAME.test(name)) throw new TypeError('tool definitions must be named executable tools; invalid MCP tool selector');
    } else if (typeof name !== 'string' || !name.trim() || typeof fields.get('execute') !== 'function') {
      throw new TypeError('tool definitions must be named executable tools or exact MCP selectors');
    }
    if (names.has(name)) throw new TypeError('toolDefinitionsFactory returned duplicate tool names');
    names.add(name);
    tools.push(selector ? Object.freeze({ name }) : tool);
  }
  return Object.freeze(tools);
}

export function createDefaultResourceLoader({ sdk, cwd, agentDir, settingsManager, toolDefinitions, extensionFactories = [] }) {
  return new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...extensionFactories, pi => { for (const tool of toolDefinitions) pi.registerTool(tool); }],
  });
}

// Trusted host integration only; never derive this factory from request/model data.
// Tool selection is NOT an OS sandbox.
function responseMetrics(message, startedAt) {
  const usage = message?.role === 'assistant' ? message.usage : null;
  if (!usage || startedAt === null) return null;
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
  if (keys.some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0)) return null;
  return { ...Object.fromEntries(keys.map(key => [key, usage[key]])), durationMs: Math.max(1, Date.now() - startedAt) };
}

export function createPiAdapter({ sdk, modelRuntime, model, root, cwd, toolDefinitions = [], toolDefinitionsFactory, extensionFactoriesFactory, resourceLoaderFactory, restoredSessionFiles, onEvent = () => {} }) {
  if (!sdk || !modelRuntime || !model || typeof root !== 'string' || !root || typeof cwd !== 'string' || !cwd) throw new TypeError('explicit SDK, model/runtime, root and cwd required');
  if (toolDefinitionsFactory !== undefined && typeof toolDefinitionsFactory !== 'function') throw new TypeError('toolDefinitionsFactory must be a trusted function');
  if (toolDefinitionsFactory && toolDefinitions.length > 0) throw new TypeError('toolDefinitions and toolDefinitionsFactory are mutually exclusive');
  if (extensionFactoriesFactory !== undefined && typeof extensionFactoriesFactory !== 'function') throw new TypeError('extensionFactoriesFactory must be a trusted function');
  if (resourceLoaderFactory !== undefined && typeof resourceLoaderFactory !== 'function') throw new TypeError('resourceLoaderFactory must be a trusted function');
  toolDefinitions = snapshotToolDefinitions(toolDefinitions, typeof resourceLoaderFactory === 'function');
  const sessionRoot = resolve(root);
  const restoredFiles = snapshotRestoredSessionFiles(restoredSessionFiles);
  const sessions = new Map();
  const cancellationEpochs = new Map();
  const activeTurns = new Set();
  let closed = false;
  let closing;
  async function getSession(id) {
    if (!validId(id)) throw new TypeError('invalid session id');
    if (closed) throw new Error('HOST_CLOSED');
    if (!sessions.has(id)) {
      const pending = (async () => {
        const directory = join(sessionRoot, 'sessions', id);
        const agentDir = join(sessionRoot, 'agent');
        const isRestored = restoredFiles && Object.hasOwn(restoredFiles, id);
        if (isRestored) {
          const checked = await checkedRestoredSessionFile(sessionRoot, id, restoredFiles[id]);
          if (checked.directory !== directory) throw new Error('RESTORED_SESSION_INVALID');
        } else {
          await mkdir(join(sessionRoot, 'sessions'), { recursive: true, mode: 0o700 });
          await mkdir(directory, { recursive: true, mode: 0o700 });
        }
        await mkdir(agentDir, { recursive: true, mode: 0o700 });
        const selection = { sessionId: id, sdk, cwd, agentDir };
        const selectedTools = toolDefinitionsFactory
          ? snapshotToolDefinitions(await toolDefinitionsFactory(selection), typeof resourceLoaderFactory === 'function')
          : toolDefinitions;
        const extensionFactories = extensionFactoriesFactory ? await extensionFactoriesFactory(selection) : [];
        if (!Array.isArray(extensionFactories) || extensionFactories.length > 8 || extensionFactories.some(factory => typeof factory !== 'function')) throw new TypeError('invalid extension factories');
        let sessionManager;
        if (isRestored) {
          const { file } = await checkedRestoredSessionFile(sessionRoot, id, restoredFiles[id]);
          sessionManager = sdk.SessionManager.open(file, directory, cwd);
          const header = sessionManager.getHeader?.();
          const uuid = restoredUuid(restoredFiles[id]);
          if (!header || header.type !== 'session' || header.id !== uuid || sessionManager.getSessionId?.() !== uuid || sessionManager.getSessionFile?.() !== file || sessionManager.getCwd?.() !== cwd || sessionManager.getEntryCount?.() < 1) throw new Error('RESTORED_SESSION_IDENTITY_INVALID');
        } else sessionManager = sdk.SessionManager.continueRecent(cwd, directory);
        const createRuntime = async ({ sessionManager: activeSessionManager, sessionStartEvent }) => {
          const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
          const loaderSelection = { ...selection, settingsManager, toolDefinitions: selectedTools,
            ...(extensionFactoriesFactory ? { extensionFactories } : {}) };
          const resourceLoader = resourceLoaderFactory
            ? await resourceLoaderFactory(loaderSelection)
            : createDefaultResourceLoader({ ...loaderSelection, extensionFactories });
          if (resourceLoaderFactory && !isResourceLoader(resourceLoader)) throw new TypeError('resourceLoaderFactory must return an SDK-compatible ResourceLoader');
          await resourceLoader.reload();
          const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
          const created = await sdk.createAgentSessionFromServices({
            services, sessionManager: activeSessionManager, sessionStartEvent, model, thinkingLevel: 'low',
            tools: selectedTools.map(tool => tool.name),
          });
          return { ...created, services, diagnostics: services.diagnostics };
        };
        const runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
        const session = runtime.session;
        try {
          await session.bindExtensions({});
          if (closed) throw new Error('HOST_CLOSED');
        } catch (error) {
          await runtime.dispose();
          throw error;
        }
        let responseStartedAt = null;
        const unsubscribe = session.subscribe(event => {
          if (event.type === 'message_start' && event.message?.role === 'assistant') responseStartedAt = Date.now();
          if (event.type === 'message_end') {
            const usage = responseMetrics(event.message, responseStartedAt);
            if (usage) onEvent({ sessionId: id, type: 'turn_usage', usage });
          }
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') onEvent({ sessionId: id, type: 'text_delta', text: event.assistantMessageEvent.delta });
          if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') onEvent({
            sessionId: id, type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
            ...(event.type === 'tool_execution_end' ? { isError: event.isError === true } : {}),
          });
        });
        return { session, runtime, unsubscribe };
      })();
      sessions.set(id, pending);
      pending.catch(() => { if (sessions.get(id) === pending) sessions.delete(id); });
    }
    return sessions.get(id);
  }
  return {
    async prompt(id, text, options) {
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1024) throw new TypeError('invalid prompt');
      if (!validId(id)) throw new TypeError('invalid session id');
      if (activeTurns.has(id)) throw new Error('SESSION_BUSY');
      activeTurns.add(id);
      try {
        const epoch = cancellationEpochs.get(id) ?? 0;
        const { session } = await getSession(id);
        if (closed) throw new Error('HOST_CLOSED');
        if ((cancellationEpochs.get(id) ?? 0) !== epoch) throw new Error('CANCELLED');
        if (options?.model && (session.model?.provider !== options.model.provider || session.model?.id !== options.model.id)) {
          await session.setModel(options.model, { persist: false });
        }
        if (options?.reasoning) session.setThinkingLevel(options.reasoning, { persist: false });
        await session.prompt(text);
        const last = session.messages.findLast(message => message.role === 'assistant');
        if (last?.stopReason === 'error' || last?.stopReason === 'aborted') throw new Error(last.stopReason === 'aborted' ? 'CANCELLED' : 'PROVIDER_FAILED');
        return { text: session.getLastAssistantText(), nativeSessionFile: session.sessionFile };
      } finally { activeTurns.delete(id); }
    },
    async cancel(id) {
      if (!validId(id)) throw new TypeError('invalid session id');
      const pending = sessions.get(id);
      if (!pending) return false;
      cancellationEpochs.set(id, (cancellationEpochs.get(id) ?? 0) + 1);
      await (await pending).session.abort();
      return true;
    },
    shutdown() {
      if (closing) return closing;
      closed = true;
      closing = Promise.all([...sessions.values()].map(async item => {
        let instance;
        try { instance = await item; } catch { return; } // failed creation owns no live session
        try { await instance.session.abort(); }
        finally {
          instance.unsubscribe();
          await instance.runtime.dispose();
        }
      })).then(() => { sessions.clear(); cancellationEpochs.clear(); });
      return closing;
    },
  };
}
