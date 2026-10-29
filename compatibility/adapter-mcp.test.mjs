import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createWorkerAdapter } from '../runtime/pi-worker.mjs';
import { createNativeMcpFetch } from '../runtime/native-mcp-transport.mjs';
import { assertSdkManifest } from '../agent-host/sdk-compat.mjs';

const sdkRoot = resolve(process.env.AYLACHI_SDK_ROOT ?? '');
assert.ok(process.env.AYLACHI_SDK_ROOT, 'set AYLACHI_SDK_ROOT to the selected installed Pi SDK');
const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
const nodeModules = resolve(join(sdkRoot, '../..'));
const piAiRoot = join(nodeModules, '@earendil-works/pi-ai');
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(piAiRoot, 'dist/utils/event-stream.js')).href);
const { InMemoryAuthStorageBackend } = await import(pathToFileURL(join(sdkRoot, 'dist/core/auth-storage.js')).href);
const { McpOAuthCredentialStore } = await import(pathToFileURL(join(sdkRoot, 'dist/extensions/mcp/oauth.js')).href);
const manifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
const mcpManifest = JSON.parse(await readFile(join(nodeModules, '@earendil-works/pi-mcp/package.json'), 'utf8'));
const { McpClient, StreamableHttpTransport } = await import(pathToFileURL(join(nodeModules, '@earendil-works/pi-mcp/dist/index.js')).href);
const piAiManifest = JSON.parse(await readFile(join(piAiRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@earendil-works/pi-coding-agent');
assertSdkManifest(manifest);
assert.equal(mcpManifest.version, manifest.version);
assert.equal(piAiManifest.version, manifest.version);

const model = { id: 'synthetic-adapter-mcp', name: 'Synthetic adapter MCP', api: 'openai-codex-responses', provider: 'synthetic', baseUrl: 'http://127.0.0.1/unused', reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (content, stopReason) => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason, timestamp: Date.now() });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(25);
  }
  return Boolean(await check());
};
const readIfExists = path => readFile(path, 'utf8').catch(() => undefined);
const exists = path => access(path).then(() => true, () => false);

function syntheticRuntime() {
  const requests = [];
  const toolResults = [];
  const prompted = new Map();
  const runtime = {
    requests,
    toolResults,
    getAvailable: async () => [model],
    getModel: () => model,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: 'api_key', source: 'synthetic adapter fixture' }),
    isUsingOAuth: () => false,
    streamSimple(selected, context, options) { return this.stream(selected, context, options); },
    stream(_selected, context) {
      const stream = createAssistantMessageEventStream();
      const messages = context.messages ?? [];
      const last = messages.at(-1);
      const lastUser = [...messages].reverse().find(message => message.role === 'user');
      const userText = typeof lastUser?.content === 'string' ? lastUser.content : lastUser?.content?.map?.(part => part.text ?? '').join('') ?? '';
      requests.push({ userText, lastRole: last?.role });
      const empty = assistant([], 'stop');
      stream.push({ type: 'start', partial: empty });
      if (last?.role === 'toolResult') {
        toolResults.push({ userText, isError: last.isError === true, text: last.content?.map?.(part => part.text ?? '').join('') ?? '' });
        const text = `observed:${last.content?.map?.(part => part.text ?? '').join('') ?? ''}`;
        const final = assistant([{ type: 'text', text }], 'stop');
        stream.push({ type: 'text_start', contentIndex: 0, partial: empty });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: final });
        stream.push({ type: 'done', reason: 'stop', message: final });
      } else if ((prompted.get(userText) ?? 0) === 0) {
        prompted.set(userText, 1);
        const value = /ERROR/.test(userText) ? 'fail' : 'safe';
        const call = { type: 'toolCall', id: `adapter-mcp-${requests.length}`, name: 'mcp__fixture__echo', arguments: { text: value } };
        const message = assistant([call], 'toolUse');
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: empty });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message });
        stream.push({ type: 'done', reason: 'toolUse', message });
      } else {
        const final = assistant([{ type: 'text', text: `missing-tool-result:${userText}` }], 'stop');
        stream.push({ type: 'text_start', contentIndex: 0, partial: empty });
        stream.push({ type: 'text_end', contentIndex: 0, content: final.content[0].text, partial: final });
        stream.push({ type: 'done', reason: 'stop', message: final });
      }
      return stream;
    },
    complete: async () => { throw new Error('unexpected synthetic completion path'); },
  };
  return runtime;
}

test('selected worker adapter routes native MCP success/error via prompt and awaits shutdown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-adapter-mcp-'));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  const stateRoot = join(root, 'state');
  const xdg = join(root, 'xdg');
  await Promise.all([home, cwd, xdg].map(path => mkdir(path, { recursive: true })));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(xdg, 'config');
  process.env.XDG_DATA_HOME = join(xdg, 'data');
  process.env.XDG_STATE_HOME = join(xdg, 'state');
  process.env.XDG_CACHE_HOME = join(xdg, 'cache');
  assert.deepEqual(await readdir(home), [], 'temporary HOME starts empty');
  assert.deepEqual(await readdir(cwd), [], 'temporary cwd starts empty');
  assert.deepEqual(Object.keys(process.env).filter(key => /API_KEY|TOKEN|AUTH|CREDENTIAL|SECRET/i.test(key)), [], 'sanitized worker must not receive credential environment variables');

  const fixturePath = fileURLToPath(new URL('./mcp-fixture-server.mjs', import.meta.url));
  const toolName = 'mcp__fixture__echo';
  // This exact selector is not registered as a tool; createMcpExtension owns the executable tool.
  const fixtures = [];
  const sessionStarts = [];
  const sessionShutdowns = [];
  const toolEvents = [];
  const modelRuntime = syntheticRuntime();
  await mkdir(stateRoot, { mode: 0o700 });
  const adapter = createWorkerAdapter({
    sdk, modelRuntime, model, root: stateRoot, cwd, deadlineEpochMs: Date.now() + 120_000, maxSdkCalls: 6,
    toolDefinitionsFactory: ({ sessionId }) => {
      assert.ok(['alpha', 'beta'].includes(sessionId));
      return [{ name: toolName }];
    },
    resourceLoaderFactory: async ({ sessionId, sdk: actualSdk, cwd: actualCwd, agentDir, settingsManager, toolDefinitions, getTurnContext }) => {
      assert.ok(['alpha', 'beta'].includes(sessionId));
      assert.equal(typeof getTurnContext, 'function');
      assert.strictEqual(actualSdk, sdk);
      assert.equal(actualCwd, cwd);
      assert.equal(agentDir, join(stateRoot, 'pi', 'agent'));
      assert.deepEqual(toolDefinitions.map(item => item.name), [toolName]);
      assert.deepEqual(settingsManager.getSkillPaths(), []);
      assert.deepEqual(settingsManager.getExtensionPaths(), []);
      assert.deepEqual(settingsManager.getPackages(), []);
      const index = fixtures.length;
      const fixtureRoot = join(root, `fixture-${index}`);
      await mkdir(fixtureRoot, { recursive: true });
      const auditPath = join(fixtureRoot, 'mcp-audit.jsonl');
      const startPath = join(fixtureRoot, 'mcp-started.pid');
      const exitPath = join(fixtureRoot, 'mcp-exited.pid');
      const logPath = join(fixtureRoot, 'mcp.log');
      const record = { index, fixtureRoot, auditPath, startPath, exitPath, logPath, loadConfigCalls: 0, openUrlCalls: 0, updateConfigCalls: 0, registered: [], loader: undefined, settingsManager };
      const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend(), fixtureRoot);
      const serverConfig = {
        type: 'stdio', command: process.execPath,
        args: [fixturePath, auditPath, startPath, exitPath],
        cwd, env: {}, exposure: 'direct', description: 'Isolated safe echo test fixture', timeout: 5,
      };
      record.loader = new actualSdk.DefaultResourceLoader({
        cwd: actualCwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          actualSdk.createMcpExtension({
            loadConfig: () => { record.loadConfigCalls++; return { servers: [], errors: [], autoEnableCodemode: false, projectConfig: undefined }; },
            credentials,
            logPath,
            startupWaitMs: 1000,
            openUrl: () => { record.openUrlCalls++; throw new Error('unexpected fixture auth flow'); },
            updateConfig: () => { record.updateConfigCalls++; throw new Error('unexpected MCP config write'); },
          }),
          pi => {
            pi.registerMcpServer('fixture', serverConfig);
            pi.on('session_start', event => {
              sessionStarts.push({ index, reason: event.reason });
              record.registered = pi.getMcpServers().map(server => server.name);
            });
            pi.on('session_shutdown', event => sessionShutdowns.push({ index, reason: event.reason }));
          },
        ],
      });
      fixtures.push(record);
      return record.loader;
    },
    onEvent: event => { if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') toolEvents.push(event); },
  });
  t.after(async () => {
    await adapter.shutdown();
    const missingExits = [];
    for (const fixture of fixtures) {
      const mayBeLive = fixture.loadConfigCalls > 0 || sessionStarts.some(event => event.index === fixture.index) || await exists(fixture.startPath);
      if (mayBeLive && !await waitFor(() => exists(fixture.exitPath), 2500)) missingExits.push(fixture.exitPath);
    }
    if (missingExits.length) throw new Error(`fixture exit unconfirmed; retaining owned scratch ${root}; missing exit markers: ${missingExits.join(', ')}`);
    await rm(root, { recursive: true, force: true });
  });

  const attempts = [];
  for (const [sessionId, prompt] of [
    ['alpha', 'TRY_SUCCESS_ALPHA'],
    ['alpha', 'TRY_ERROR_ALPHA'],
    ['beta', 'TRY_SUCCESS_BETA'],
  ]) {
    try {
      const result = await adapter.prompt(sessionId, prompt);
      attempts.push({ sessionId, prompt, status: 'fulfilled', text: result.text });
    } catch (error) {
      attempts.push({ sessionId, prompt, status: 'rejected', error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` });
    }
  }

  await adapter.shutdown();
  const readiness = [];
  for (const fixture of fixtures) {
    const ready = await waitFor(async () => fixture.loadConfigCalls > 0 || await exists(fixture.startPath) || fixture.loader.getExtensions().errors.length > 0, 1500);
    const started = await exists(fixture.startPath);
    const exited = started && await waitFor(() => exists(fixture.exitPath), 2500);
    const auditText = await readIfExists(fixture.auditPath);
    const audit = auditText ? auditText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    readiness.push({
      index: fixture.index, ready, loadConfigCalls: fixture.loadConfigCalls,
      extensionErrors: fixture.loader.getExtensions().errors,
      activeExtensionFactories: fixture.loader.getExtensions().extensions.map(extension => extension.path),
      sessionStarts: sessionStarts.filter(event => event.index === fixture.index),
      sessionShutdowns: sessionShutdowns.filter(event => event.index === fixture.index),
      registered: fixture.registered,
      started, exited,
      auditMethods: audit.map(entry => entry.method),
      toolCalls: audit.filter(entry => entry.method === 'tools/call').map(entry => entry.params),
      fixtureResults: audit.filter(entry => entry.method === 'fixture/result').map(entry => ({ isError: entry.isError, content: entry.content })),
      mcpLog: await readIfExists(fixture.logPath),
      ioSeams: { openUrlCalls: fixture.openUrlCalls, updateConfigCalls: fixture.updateConfigCalls },
    });
  }
  const callCounts = Object.fromEntries(['TRY_SUCCESS_ALPHA', 'TRY_ERROR_ALPHA', 'TRY_SUCCESS_BETA'].map(prompt => [prompt, modelRuntime.requests.filter(request => request.userText.includes(prompt)).length]));
  const toolResults = modelRuntime.toolResults;
  const diagnostics = {
    sdk: `${manifest.name}@${manifest.version}`,
    mcp: `${mcpManifest.name}@${mcpManifest.version}`,
    piAi: `${piAiManifest.name}@${piAiManifest.version}`,
    node: process.version,
    testPath: new URL(import.meta.url).pathname,
    attempts, callCounts, modelRequestCount: modelRuntime.requests.length, toolResults,
    toolEvents: toolEvents.map(({ sessionId, type, toolName: name, isError }) => ({ sessionId, type, toolName: name, isError })),
    readiness, globalConfigWriteChecks: fixtures.map(fixture => ({ loadConfigCalls: fixture.loadConfigCalls, openUrlCalls: fixture.openUrlCalls, updateConfigCalls: fixture.updateConfigCalls })),
  };
  console.log(JSON.stringify(diagnostics));

  assert.equal(fixtures.length, 2, 'adapter should create separate resource instances for alpha and beta');
  assert.notStrictEqual(fixtures[0].loader, fixtures[1].loader, 'each session must own a distinct ResourceLoader');
  assert.notStrictEqual(fixtures[0].settingsManager, fixtures[1].settingsManager, 'each session must own distinct in-memory settings');
  assert.deepEqual(attempts.map(attempt => attempt.status), ['fulfilled', 'fulfilled', 'fulfilled'], JSON.stringify(diagnostics));
  assert.deepEqual(attempts.map(attempt => attempt.text), [
    'observed:echo:safe',
    'observed:intentional fixture tool error',
    'observed:echo:safe',
  ], JSON.stringify(diagnostics));
  assert.deepEqual(callCounts, { TRY_SUCCESS_ALPHA: 2, TRY_ERROR_ALPHA: 2, TRY_SUCCESS_BETA: 2 }, 'one tool-selection request and one result request per explicit prompt; no retry/autoreplay');
  assert.deepEqual(toolResults.map(result => [result.userText.match(/TRY_(?:SUCCESS|ERROR)_[A-Z]+/)?.[0], result.isError]), [
    ['TRY_SUCCESS_ALPHA', false], ['TRY_ERROR_ALPHA', true], ['TRY_SUCCESS_BETA', false],
  ], JSON.stringify(diagnostics));
  assert.deepEqual(toolEvents.filter(event => event.type === 'tool_execution_end' && event.toolName === toolName).map(event => [event.sessionId, event.isError]), [
    ['alpha', false], ['alpha', true], ['beta', false],
  ], JSON.stringify(diagnostics));
  assert.deepEqual(readiness.map(item => item.started), [true, true], 'both isolated stdio fixture processes must start');
  assert.deepEqual(readiness.map(item => item.exited), [true, true], 'awaited adapter.shutdown must observe both fixture exit markers');
  assert.deepEqual(readiness.map(item => item.auditMethods.includes('initialize') && item.auditMethods.includes('tools/list')), [true, true]);
  assert.deepEqual(readiness.map(item => item.toolCalls.map(call => call.arguments.text)), [['safe', 'fail'], ['safe']], JSON.stringify(diagnostics));
  assert.deepEqual(readiness.map(item => item.fixtureResults.map(result => result.isError)), [[false, true], [false]], JSON.stringify(diagnostics));
  assert.ok(readiness.every(item => item.sessionStarts.length === 1 && item.registered.includes('fixture')), JSON.stringify(diagnostics));
  assert.ok(readiness.every(item => item.extensionErrors.length === 0), JSON.stringify(diagnostics));
  assert.ok(fixtures.every(fixture => fixture.loadConfigCalls === 1), 'each extension must consume only its injected empty MCP config');
  assert.ok(fixtures.every(fixture => fixture.openUrlCalls === 0 && fixture.updateConfigCalls === 0), 'no auth browser/config write');
  for (const path of [join(home, '.pi', 'agent', 'mcp.json'), join(home, '.pi', 'agent', 'mcp-auth.json'), join(cwd, '.pi', 'mcp.json'), join(stateRoot, 'pi', 'agent', 'mcp.json'), join(stateRoot, 'pi', 'agent', 'mcp-auth.json')]) {
    assert.equal(await exists(path), false, `no ambient MCP config/credential file may be created: ${path}`);
  }
});

test('bounded HTTP fetch supports the pinned native MCP client without auth or streams', async () => {
  const url = 'http://127.0.0.1:43123/mcp';
  const methods = [];
  const guardedFetch = createNativeMcpFetch({ url, fetchImpl: async (target, init) => {
    assert.equal(target, url);
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.has('authorization'), false);
    const message = JSON.parse(init.body);
    methods.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bounded-fixture', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'bounded-echo' }] };
    else throw new Error('unexpected fixture method');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
  } });
  const transport = new StreamableHttpTransport({ url, fetch: guardedFetch, openGetStream: false, maxMessageBytes: 32768, reconnect: { maxRetries: 0 } });
  const client = new McpClient({ name: 'aylachi-bounded-test', version: '1', requestTimeoutMs: 6000 });
  try {
    await client.connect(transport);
    assert.equal(client.protocolVersion, '2025-06-18');
    assert.deepEqual((await client.listTools()).map(tool => tool.name), ['echo']);
    assert.equal((await client.callTool('echo', {})).content[0].text, 'bounded-echo');
  } finally { await client.close(); }
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(client.connectionState, 'closed');
});
