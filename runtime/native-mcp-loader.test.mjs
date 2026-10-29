import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeMcpFactories } from './native-mcp-loader.mjs';

const url = 'http://127.0.0.1:43210/mcp';
const binding = Object.freeze({ cardId: 'card-a', sessionId: 'session-a', serverName: 'catalog', url, tools: Object.freeze(['echo']) });
const errorCode = 'NATIVE_MCP_LOADER_DENIED';
const isDenied = error => error?.code === errorCode && error.message === errorCode;
const toolName = 'mcp__catalog__echo';
const executable = { name: 'project_context', label: 'Project context', description: 'Synthetic executable', parameters: {}, execute: async () => ({ content: [] }) };

function makeHarness(bindings = [binding]) {
  const credentials = [], extensions = [], loaders = [], transports = [];
  class StreamableHttpTransport {
    constructor(options) { transports.push(options); this.options = options; }
  }
  class DefaultResourceLoader {
    constructor(options) { loaders.push(options); this.options = options; }
  }
  const sdk = {
    DefaultResourceLoader,
    createMcpExtension(options) { extensions.push(options); return () => {}; },
  };
  const factories = createNativeMcpFactories({
    bindings, StreamableHttpTransport,
    createCredentials: agentDir => { credentials.push(agentDir); return { inMemory: true }; },
  });
  return { factories, sdk, credentials, extensions, loaders, transports };
}

function makeSelection(harness, sessionId, toolDefinitions, getTurnContext = () => undefined) {
  return {
    sessionId, sdk: harness.sdk, cwd: '/private/workspace', agentDir: '/private/agent',
    settingsManager: { trusted: true }, toolDefinitions, getTurnContext,
  };
}

function activate(loader) {
  const registeredServers = [], registeredTools = [], hooks = [];
  const pi = {
    registerMcpServer: (...args) => registeredServers.push(args),
    registerTool: tool => registeredTools.push(tool),
    on: (event, handler) => { if (event === 'tool_call') hooks.push(handler); },
  };
  for (const factory of loader.options.extensionFactories) factory(pi);
  return { registeredServers, registeredTools, hooks };
}

function rpcRequest(method, id, params) {
  return { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) };
}
function rpcResponse(id, result, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status, headers: { 'content-type': 'application/json' } });
}
async function withFetch(fetchImpl, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetchImpl });
  try { return await fn(); }
  finally { Object.defineProperty(globalThis, 'fetch', descriptor); }
}

async function makeBoundTransport(harness, getTurnContext) {
  const selectors = harness.factories.toolDefinitionsFactory({ sessionId: binding.sessionId });
  const loader = await harness.factories.resourceLoaderFactory(makeSelection(harness, binding.sessionId, [...selectors, executable], getTurnContext));
  const registrations = activate(loader);
  const options = harness.extensions[0];
  let authReads = 0;
  const authProvider = Object.defineProperty({}, 'token', { enumerable: true, get() { authReads++; throw new Error('must not inspect auth'); } });
  const transport = options.createTransport({ untrusted: true }, '/private/workspace', authProvider).options;
  return { loader, registrations, options, transport, selectors, authReads: () => authReads };
}

test('factory snapshots bindings and emits exact selectors only for their session', async () => {
  const harness = makeHarness();
  assert.deepEqual(harness.factories.toolDefinitionsFactory({ sessionId: binding.sessionId }), [{ name: toolName }]);
  assert.deepEqual(harness.factories.toolDefinitionsFactory({ sessionId: 'unbound' }), []);
  let reads = 0;
  const bad = Object.defineProperty({}, 'bindings', { enumerable: true, get() { reads++; return [binding]; } });
  assert.throws(() => createNativeMcpFactories(bad), isDenied);
  assert.equal(reads, 0);
  await assert.rejects(harness.factories.resourceLoaderFactory(makeSelection(harness, 'session-a', [{ name: 'mcp__other__tool' }])), isDenied);
});

test('bound loader installs only its native server and executable tools, then guards HTTP methods and pins metadata', async () => {
  const harness = makeHarness();
  let current;
  const context = Object.freeze({ sessionId: binding.sessionId, turnId: 'turn-1' });
  current = context;
  const requestLog = [];
  await withFetch(async (target, init) => {
    const message = JSON.parse(init.body);
    requestLog.push({ target, method: message.method, headers: [...init.headers.keys()] });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'initialize') return rpcResponse(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } });
    if (message.method === 'tools/list') {
      const description = requestLog.filter(item => item.method === 'tools/list').length === 1 ? 'fixed' : 'changed';
      return rpcResponse(message.id, { tools: [{ name: 'echo', description, inputSchema: { type: 'object' } }] });
    }
    if (message.method === 'tools/call') return rpcResponse(message.id, { content: [{ type: 'text', text: 'synthetic result' }] });
    throw new Error('unexpected mock method');
  }, async () => {
    const result = await makeBoundTransport(harness, () => current);
    const { options, registrations, selectors, transport } = result;
    assert.equal(result.authReads(), 0);
    assert.deepEqual(selectors, [{ name: toolName }]);
    assert.deepEqual(registrations.registeredTools.map(tool => tool.name), ['project_context']);
    assert.deepEqual(registrations.registeredServers, [[binding.serverName, {
      type: 'http', url, exposure: 'hidden', toolExposure: { echo: 'direct' }, timeout: 5,
    }]]);
    assert.equal(harness.credentials.length, 1);
    assert.equal(harness.credentials[0], '/private/agent');
    assert.deepEqual(options.loadConfig(), { servers: [], errors: [], autoEnableCodemode: false, projectConfig: undefined });
    assert.equal(options.startupWaitMs, 5000);
    assert.equal(options.logPath, '/private/agent/native-mcp-session-a.log');
    assert.equal(result.loader.options.noExtensions, true);
    assert.equal(result.loader.options.noSkills, true);
    assert.equal(result.loader.options.noPromptTemplates, true);
    assert.equal(result.loader.options.noThemes, true);
    assert.equal(result.loader.options.noContextFiles, true);
    assert.deepEqual(transport, {
      url, fetch: transport.fetch, openGetStream: false, maxMessageBytes: 32768, reconnect: { maxRetries: 0 },
    });
    assert.equal(typeof transport.fetch, 'function');
    assert.throws(() => options.openUrl(), isDenied);
    assert.throws(() => options.updateConfig(), isDenied);
  });
});

test('native request dispatch allows startup/list, requires active bound turn for calls, and fails sticky on changed metadata', async () => {
  const harness = makeHarness();
  let current = Object.freeze({ sessionId: binding.sessionId, turnId: 'turn-1' });
  let listChanged = false, calls = 0;
  await withFetch(async (_target, init) => {
    calls++;
    const message = JSON.parse(init.body);
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'initialize') return rpcResponse(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } });
    if (message.method === 'tools/list') return rpcResponse(message.id, { tools: [{ name: 'echo', description: listChanged ? 'changed' : 'fixed' }] });
    if (message.method === 'tools/call') return rpcResponse(message.id, { content: [] });
    throw new Error('unexpected mock method');
  }, async () => {
    const { options, transport, registrations } = await makeBoundTransport(harness, () => current);
    assert.equal(registrations.hooks[0]({ toolName: 'project_context' }), undefined);
    assert.equal(registrations.hooks[0]({ toolName, parentToolCallId: 'call-1' }), undefined);
    for (const [method, id, params] of [
      ['initialize', 1], ['notifications/initialized', undefined], ['tools/list', 2], ['tools/call', 3, { name: 'echo', arguments: {} }],
    ]) {
      const response = await transport.fetch(url, rpcRequest(method, id, params));
      assert.ok(response.status === 202 || response.ok);
    }
    listChanged = true;
    await assert.rejects(transport.fetch(url, rpcRequest('tools/list', 4)), isDenied);
    const before = calls;
    await assert.rejects(transport.fetch(url, rpcRequest('initialize', 5)), isDenied);
    assert.equal(calls, before, 'local protocol failure prevents further underlying fetches');
    assert.throws(() => options.updateConfig(), isDenied);
  });
});

test('unbound loader creates no MCP extension, credentials, server or transport', async () => {
  const harness = makeHarness();
  assert.deepEqual(harness.factories.toolDefinitionsFactory({ sessionId: 'unbound' }), []);
  const loader = await harness.factories.resourceLoaderFactory(makeSelection(harness, 'unbound', [executable]));
  const registrations = activate(loader);
  assert.equal(harness.extensions.length, 0);
  assert.equal(harness.credentials.length, 0);
  assert.deepEqual(registrations.registeredServers, []);
  assert.deepEqual(registrations.registeredTools.map(tool => tool.name), ['project_context']);
  assert.equal(registrations.hooks[0]({ toolName: 'mcp__catalog__helper' }).block, true);
});

test('wrong native tool, absent turn, and stale context fail closed without another dispatch', async () => {
  const harness = makeHarness();
  let current;
  let calls = 0;
  await withFetch(async (_target, init) => {
    calls++;
    const message = JSON.parse(init.body);
    return rpcResponse(message.id, { content: [] });
  }, async () => {
    const { transport, registrations } = await makeBoundTransport(harness, () => current);
    assert.deepEqual(registrations.hooks[0]({ toolName }), { block: true, reason: 'MCP_CALL_DENIED' });
    await assert.rejects(transport.fetch(url, rpcRequest('tools/call', 1, { name: 'echo', arguments: {} })), isDenied);
    assert.equal(calls, 0);
  });
});

test('active context identity must remain unchanged through an awaited tools/call', async () => {
  const harness = makeHarness();
  let current = Object.freeze({ sessionId: binding.sessionId, turnId: 'turn-before' });
  let entered;
  const hasEntered = new Promise(resolve => { entered = resolve; });
  let release;
  const responseReady = new Promise(resolve => { release = resolve; });
  let calls = 0;
  await withFetch(async (_target, init) => {
    calls++;
    const message = JSON.parse(init.body);
    entered();
    await responseReady;
    return rpcResponse(message.id, { content: [] });
  }, async () => {
    const { transport } = await makeBoundTransport(harness, () => current);
    const pending = transport.fetch(url, rpcRequest('tools/call', 1, { name: 'echo', arguments: {} }));
    await hasEntered;
    current = Object.freeze({ sessionId: binding.sessionId, turnId: 'turn-after' });
    release();
    await assert.rejects(pending, isDenied);
    await assert.rejects(transport.fetch(url, rpcRequest('initialize', 2)), isDenied);
    assert.equal(calls, 1);
  });
});

test('listChanged JSON notifications fail sticky before another request', async () => {
  const harness = makeHarness();
  await withFetch(async (_target, init) => {
    const message = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }), { headers: { 'content-type': 'application/json' } });
  }, async () => {
    const { transport } = await makeBoundTransport(harness, () => Object.freeze({ sessionId: binding.sessionId, turnId: 'turn-1' }));
    await assert.rejects(transport.fetch(url, rpcRequest('initialize', 1)), isDenied);
  });
});

test('second transport creation and unselected method/tool are denied before dispatch', async () => {
  const harness = makeHarness();
  let calls = 0;
  await withFetch(async (_target, init) => {
    calls++;
    const message = JSON.parse(init.body);
    return rpcResponse(message.id, { tools: [{ name: 'echo' }] });
  }, async () => {
    const { options, transport, registrations } = await makeBoundTransport(harness, () => Object.freeze({ sessionId: binding.sessionId, turnId: 'turn-1' }));
    assert.throws(() => options.createTransport({}, '/private/workspace', undefined), isDenied);
    await assert.rejects(transport.fetch(url, rpcRequest('initialize', 1)), isDenied);
    assert.equal(harness.transports.length, 1);
    assert.equal(calls, 0);
  });

  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'resources/list' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unlisted', arguments: {} } },
  ]) {
    const isolated = makeHarness();
    let dispatched = 0;
    await withFetch(async () => { dispatched++; return rpcResponse(1, {}); }, async () => {
      const { transport } = await makeBoundTransport(isolated, () => Object.freeze({ sessionId: binding.sessionId, turnId: 'turn-1' }));
      await assert.rejects(transport.fetch(url, { method: 'POST', body: JSON.stringify(message) }), isDenied);
      assert.equal(dispatched, 0);
    });
  }
});
