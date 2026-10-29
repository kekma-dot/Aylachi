import { isAbsolute, join, resolve } from 'node:path';
import { createNativeMcpFetch } from './native-mcp-transport.mjs';
import { snapshotNativeMcpBindings } from './native-mcp-config.mjs';

const FAILURE_CODE = 'NATIVE_MCP_LOADER_DENIED';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MCP_NAME = /^mcp__[a-z][a-z0-9_]{0,31}__[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
const REQUEST_METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
const fail = () => Object.assign(new Error(FAILURE_CODE), { code: FAILURE_CODE });

function ownDataRecord(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();
  const keys = Reflect.ownKeys(value);
  if (expectedKeys && (keys.length !== expectedKeys.length || expectedKeys.some(key => !keys.includes(key)))) throw fail();
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') throw fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail();
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value, max = 100) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw fail();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  const keys = Reflect.ownKeys(value);
  if (!Number.isSafeInteger(length) || length > max || keys.length !== length + 1 || !keys.includes('length')) throw fail();
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail();
    result.push(descriptor.value);
  }
  return result;
}

function selectionSession(value) {
  const selection = ownDataRecord(value);
  if (typeof selection.sessionId !== 'string' || !SESSION_ID.test(selection.sessionId)) throw fail();
  return selection.sessionId;
}

function snapshotTools(value, selectedNativeNames) {
  const tools = denseArray(value);
  const definitions = [], executableNames = new Set(), selectors = new Set(), allNames = new Set();
  for (const tool of tools) {
    const fields = ownDataRecord(tool);
    const name = fields.name;
    if (fields.name === undefined) throw fail();
    if (Reflect.ownKeys(tool).length === 1) {
      if (typeof name !== 'string' || !MCP_NAME.test(name) || !selectedNativeNames.has(name) || selectors.has(name)) throw fail();
      selectors.add(name);
      allNames.add(name);
      definitions.push(Object.freeze({ name }));
      continue;
    }
    if (typeof name !== 'string' || !name.trim() || typeof fields.execute !== 'function' || allNames.has(name)) throw fail();
    executableNames.add(name);
    allNames.add(name);
    definitions.push(tool);
  }
  if (selectors.size !== selectedNativeNames.size || [...selectedNativeNames].some(name => !selectors.has(name))) throw fail();
  return { definitions: Object.freeze(definitions), executableNames, selectors };
}

function activeTurn(getTurnContext, sessionId) {
  let value;
  try { value = getTurnContext(); } catch { return undefined; }
  if (value === undefined) return undefined;
  try {
    const context = ownDataRecord(value, ['sessionId', 'turnId']);
    if (!Object.isFrozen(value) || context.sessionId !== sessionId || typeof context.turnId !== 'string' || !TURN_ID.test(context.turnId)) return undefined;
    return value;
  } catch { return undefined; }
}

function inspectRequest(input, init) {
  if (init === null || typeof init !== 'object' || Array.isArray(init)) throw fail();
  const options = ownDataRecord(init);
  if (options.method !== 'POST' || typeof options.body !== 'string' || Buffer.byteLength(options.body, 'utf8') > 32 * 1024) throw fail();
  let message;
  try { message = JSON.parse(options.body); } catch { throw fail(); }
  const request = ownDataRecord(message);
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !REQUEST_METHODS.has(request.method)) throw fail();
  const hasId = Object.hasOwn(request, 'id');
  if (request.method === 'notifications/initialized') {
    if (hasId) throw fail();
  } else if (!hasId || !(typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 128) &&
      !(Number.isSafeInteger(request.id) && request.id >= 0)) throw fail();
  return { method: request.method, message: request };
}

function hasListChangedNotification(value) {
  const messages = Array.isArray(value) ? value : [value];
  return messages.some(message => message && typeof message === 'object' && message.method === 'notifications/tools/list_changed');
}

function validateToolsList(rpc, rawNames) {
  const result = ownDataRecord(rpc);
  if (result.jsonrpc !== '2.0' || !result.result || typeof result.result !== 'object' || Array.isArray(result.result)) throw fail();
  const payload = ownDataRecord(result.result);
  const tools = denseArray(payload.tools, 100);
  const seen = new Set();
  for (const item of tools) {
    const tool = ownDataRecord(item);
    if (typeof tool.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/.test(tool.name) || seen.has(tool.name)) throw fail();
    seen.add(tool.name);
  }
  if ([...rawNames].some(name => !seen.has(name))) throw fail();
  return JSON.stringify(tools);
}

function makeGuardedFetch({ binding, nativeFetch, getTurnContext, failureState }) {
  let pinnedTools;
  const selectedRawNames = new Set(binding.tools);
  return async (input, init) => {
    if (failureState.failed) throw fail();
    let response;
    try {
      const { method, message } = inspectRequest(input, init);
      let turn;
      if (method === 'tools/call') {
        const params = ownDataRecord(message.params);
        if (typeof params.name !== 'string' || !selectedRawNames.has(params.name)) throw fail();
        turn = activeTurn(getTurnContext, binding.sessionId);
        if (!turn) throw fail();
      }
      response = await nativeFetch(input, init);
      if (method === 'notifications/initialized') {
        if (response.status !== 202 || (await response.clone().text()) !== '') throw fail();
      } else {
        if (response.status === 202) throw fail();
        const rpc = await response.clone().json();
        if (hasListChangedNotification(rpc)) throw fail();
        const reply = ownDataRecord(rpc);
        if (reply.jsonrpc !== '2.0' || !Object.hasOwn(reply, 'id') || reply.id !== message.id || Object.hasOwn(reply, 'method')) throw fail();
        const hasResult = Object.hasOwn(reply, 'result'), hasError = Object.hasOwn(reply, 'error');
        if (hasResult === hasError) throw fail();
        if (hasError) {
          const rpcError = ownDataRecord(reply.error);
          if (!Number.isSafeInteger(rpcError.code) || typeof rpcError.message !== 'string' || rpcError.message.length > 1024) throw fail();
        } else if (method === 'initialize') {
          const initialized = ownDataRecord(reply.result);
          ownDataRecord(initialized.capabilities);
          const serverInfo = ownDataRecord(initialized.serverInfo);
          if (typeof initialized.protocolVersion !== 'string' || initialized.protocolVersion.length > 32 ||
              typeof serverInfo.name !== 'string' || typeof serverInfo.version !== 'string') throw fail();
        } else if (method === 'tools/call') ownDataRecord(reply.result);
        if (method === 'tools/list') {
          if (!hasResult) throw fail();
          const currentTools = validateToolsList(rpc, selectedRawNames);
          if (pinnedTools !== undefined && pinnedTools !== currentTools) throw fail();
          pinnedTools = currentTools;
        }
      }
      if (turn && activeTurn(getTurnContext, binding.sessionId) !== turn) throw fail();
      return response;
    } catch {
      failureState.failed = true;
      try { response?.body?.cancel()?.catch?.(() => {}); } catch {}
      throw fail();
    }
  };
}

export function createNativeMcpFactories(options) {
  let input;
  try {
    input = ownDataRecord(options, ['bindings', 'StreamableHttpTransport', 'createCredentials']);
    if (typeof input.StreamableHttpTransport !== 'function' || typeof input.createCredentials !== 'function') throw fail();
  } catch { throw fail(); }
  const bindings = snapshotNativeMcpBindings(input.bindings);
  const bySession = new Map(bindings.map(binding => [binding.sessionId, binding]));

  return {
    toolDefinitionsFactory(selection) {
      let sessionId;
      try { sessionId = selectionSession(selection); } catch { throw fail(); }
      const binding = bySession.get(sessionId);
      if (!binding) return [];
      return binding.tools.map(name => Object.freeze({ name: `mcp__${binding.serverName}__${name}` }));
    },

    async resourceLoaderFactory(selection) {
      let selected;
      try {
        selected = ownDataRecord(selection);
        const allowed = ['sessionId', 'sdk', 'cwd', 'agentDir', 'settingsManager', 'toolDefinitions', 'extensionFactories', 'getTurnContext'];
        const required = allowed.filter(key => key !== 'extensionFactories');
        if (Reflect.ownKeys(selection).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(selected, key))) throw fail();
        if (typeof selected.sessionId !== 'string' || !SESSION_ID.test(selected.sessionId) ||
            typeof selected.cwd !== 'string' || !isAbsolute(selected.cwd) || resolve(selected.cwd) !== selected.cwd ||
            typeof selected.agentDir !== 'string' || !isAbsolute(selected.agentDir) || resolve(selected.agentDir) !== selected.agentDir ||
            typeof selected.getTurnContext !== 'function' || !selected.sdk || typeof selected.sdk.DefaultResourceLoader !== 'function') throw fail();
      } catch { throw fail(); }
      const binding = bySession.get(selected.sessionId);
      const nativeNames = new Set(binding ? binding.tools.map(name => `mcp__${binding.serverName}__${name}`) : []);
      let tools;
      try { tools = snapshotTools(selected.toolDefinitions, nativeNames); } catch { throw fail(); }
      const { definitions, executableNames } = tools;
      const failureState = { failed: false };
      const extensionFactories = selected.extensionFactories === undefined ? [] : denseArray(selected.extensionFactories, 8);
      if (extensionFactories.some(factory => typeof factory !== 'function')) throw fail();
      if (binding) {
        let transportCreated = false;
        const createTransport = (entry, transportCwd, _authProvider) => {
          void entry; // This loader registers only its closed-over server; never trust SDK config as authority.
          void transportCwd;
          if (failureState.failed || transportCreated) {
            failureState.failed = true;
            throw fail();
          }
          transportCreated = true;
          try {
            const guardedFetch = makeGuardedFetch({
              binding, nativeFetch: createNativeMcpFetch({ url: binding.url }),
              getTurnContext: selected.getTurnContext, failureState,
            });
            return new input.StreamableHttpTransport({
              url: binding.url, fetch: guardedFetch, openGetStream: false,
              maxMessageBytes: 32 * 1024, reconnect: { maxRetries: 0 },
            });
          } catch { failureState.failed = true; throw fail(); }
        };
        let credentials, mcpExtension;
        try {
          credentials = input.createCredentials(selected.agentDir);
          if (!credentials || typeof selected.sdk.createMcpExtension !== 'function') throw fail();
          mcpExtension = selected.sdk.createMcpExtension({
            loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false, projectConfig: undefined }),
            credentials,
            logPath: join(selected.agentDir, `native-mcp-${selected.sessionId}.log`),
            startupWaitMs: 5000,
            openUrl: () => { throw fail(); },
            updateConfig: () => { throw fail(); },
            createTransport,
          });
        } catch { failureState.failed = true; throw fail(); }
        extensionFactories.push(mcpExtension);
        const serverConfig = {
          type: 'http', url: binding.url, exposure: 'hidden',
          toolExposure: Object.fromEntries(binding.tools.map(name => [name, 'direct'])), timeout: 5,
        };
        extensionFactories.push(pi => pi.registerMcpServer(binding.serverName, serverConfig));
      }
      extensionFactories.push(pi => {
        for (const tool of definitions) if (typeof tool.execute === 'function') pi.registerTool(tool);
        pi.on('tool_call', event => {
          const toolName = event?.toolName;
          if (typeof toolName === 'string' && executableNames.has(toolName)) return undefined;
          if (typeof toolName === 'string' && nativeNames.has(toolName) && binding && activeTurn(selected.getTurnContext, binding.sessionId)) return undefined;
          failureState.failed = true;
          return { block: true, reason: 'MCP_CALL_DENIED' };
        });
      });
      try {
        return new selected.sdk.DefaultResourceLoader({
          cwd: selected.cwd, agentDir: selected.agentDir, settingsManager: selected.settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories,
        });
      } catch { failureState.failed = true; throw fail(); }
    },
  };
}
