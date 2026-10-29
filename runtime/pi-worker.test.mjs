import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { createWorkerAdapter, createWorkerModelRuntime, parseWorkerEnvironment } from './pi-worker.mjs';
import { sdk } from '../agent-host/tests/fixture-runtime.mjs';

const model = { id: 'gpt-6-luna', name: 'Synthetic no-tool fixture', api: 'openai-codex-responses', provider: 'openai-codex', reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const sdkRoot = resolve(process.env.AYLACHI_SDK_ROOT);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(sdkRoot, '../..', '@earendil-works/pi-ai/dist/utils/event-stream.js')).href);

function fixture() {
  const calls = [];
  const loaderOptions = [];
  const settings = [];
  const sessions = [];
  const modelRuntime = {
    async streamSimple(target, context, options) {
      calls.push({ target, context, options });
      return { synthetic: true };
    },
  };
  class DefaultResourceLoader {
    constructor(options) { loaderOptions.push(options); }
    async reload() {}
  }
  const sdk = {
    SessionManager: { continueRecent: (cwd, sessionDirectory) => ({ cwd, sessionDirectory }) },
    SettingsManager: { inMemory: options => { settings.push(options); return { options }; } },
    DefaultResourceLoader,
    async createAgentSessionFromServices({ services, model: sessionModel, sessionManager, tools }) {
      const controller = new AbortController();
      const session = {
        messages: [],
        sessionFile: 'synthetic-session.jsonl',
        async bindExtensions() {},
        subscribe() { return () => {}; },
        async prompt(text) {
          await services.modelRuntime.streamSimple(sessionModel, { messages: [{ role: 'user', content: text }] }, {
            reasoning: 'low', maxRetries: 7, signal: controller.signal,
          });
          this.messages.push({ role: 'assistant', stopReason: 'stop' });
        },
        getLastAssistantText: () => 'Synthetic response.',
        async abort() { controller.abort(); },
      };
      sessions.push({ session, controller, tools, services });
      return { session, sessionManager };
    },
    async createAgentSessionRuntime(createRuntime, options) {
      const created = await createRuntime({ sessionManager: options.sessionManager, sessionStartEvent: {} });
      return { ...created, session: created.session, async dispose() { await created.session.abort(); } };
    },
  };
  return { sdk, modelRuntime, calls, loaderOptions, settings, sessions };
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-pi-worker-'));
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { mode: 0o700 });
  return { root, cwd };
}

const makeAdapter = (h, paths, deadlineEpochMs, maxSdkCalls, now) => createWorkerAdapter({
  sdk: h.sdk, modelRuntime: h.modelRuntime, model, ...paths, deadlineEpochMs, maxSdkCalls, now,
});

test('worker adapter keeps the synthetic default path when no restored binding is supplied', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const deadlineEpochMs = Date.now() + 60_000;
  const h = fixture();
  const adapter = createWorkerAdapter({ sdk: h.sdk, modelRuntime: h.modelRuntime, model, ...paths, deadlineEpochMs });
  await adapter.prompt('logical', 'synthetic default session');
  assert.equal(h.sessions.length, 1);
  assert.equal(h.loaderOptions[0].noExtensions, true, 'default worker path retains the isolated SDK loader');
  assert.equal(Object.hasOwn(h.loaderOptions[0], 'getTurnContext'), false);
  await adapter.shutdown();
});

test('worker resource loader receives session and fresh async turn context', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const h = fixture(), contexts = [];
  let getTurnContext;
  const streamSimple = h.modelRuntime.streamSimple.bind(h.modelRuntime);
  h.modelRuntime.streamSimple = (...args) => { contexts.push(getTurnContext?.()); return streamSimple(...args); };
  const loader = {
    getExtensions: () => ({ extensions: [], errors: [] }), getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => [], getThemes: () => [], getAgentsFiles: () => [], getSystemPrompt: () => '',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => '', getAppendSystemPromptSources: () => [],
    extendResources: async () => {}, reload: async () => {},
  };
  const deadlineEpochMs = Date.now() + 60_000;
  const adapter = createWorkerAdapter({ sdk: h.sdk, modelRuntime: h.modelRuntime, model, ...paths, deadlineEpochMs,
    resourceLoaderFactory: async selection => {
      assert.equal(selection.sessionId, 'turn-session');
      assert.equal(typeof selection.getTurnContext, 'function');
      getTurnContext = selection.getTurnContext;
      assert.deepEqual(getTurnContext(), { sessionId: 'turn-session', turnId: 'turn-one' });
      return loader;
    },
  });
  try {
    await adapter.prompt('turn-session', 'first synthetic turn', { turnId: 'turn-one' });
    await adapter.prompt('turn-session', 'second synthetic turn', { turnId: 'turn-two' });
    assert.deepEqual(contexts, [
      { sessionId: 'turn-session', turnId: 'turn-one' },
      { sessionId: 'turn-session', turnId: 'turn-two' },
    ]);
  } finally { await adapter.shutdown(); }

  const invalidPaths = await makeRoot();
  t.after(() => rm(invalidPaths.root, { recursive: true, force: true }));
  assert.throws(() => createWorkerAdapter({ sdk: h.sdk, modelRuntime: h.modelRuntime, model, ...invalidPaths,
    deadlineEpochMs: Date.now() + 60_000, resourceLoaderFactory: {} }), /trusted function/);
  await assert.rejects(readFile(join(invalidPaths.root, 'live-budget.json')), { code: 'ENOENT' });
});

test('actual worker rejects malformed restore manifest before importing the synthetic SDK', { timeout: 15_000 }, async t => {
  const { root } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeSdk = join(root, 'fake-sdk'), marker = join(root, 'sdk-imported');
  await mkdir(join(fakeSdk, 'dist'), { recursive: true, mode: 0o700 });
  await writeFile(join(fakeSdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0', type: 'module' }));
  await writeFile(join(fakeSdk, 'dist', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'synthetic SDK imported'); export const ModelRuntime = { create() { throw Error('synthetic stop before auth'); } };`);
  const manifest = join(root, '.restored-session-files.json');
  await writeFile(manifest, JSON.stringify({ format: 99, sessions: {} }), { mode: 0o600 });
  async function start(code = 'HOST_START_FAILED') {
    const child = fork(fileURLToPath(new URL('./pi-worker.mjs', import.meta.url)), [], {
      env: { PATH: process.env.PATH ?? '', HOME: join(root, 'isolated-home'), AYLACHI_DEV_STATE_ROOT: root,
        AYLACHI_SDK_ROOT: fakeSdk, AYLACHI_DEV_AUTH_PATH: join(root, 'synthetic-auth-not-present'),
        AYLACHI_DEV_DEADLINE_MS: String(Date.now() + 60_000) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const messages = [];
    await new Promise((resolveDone, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('synthetic worker timeout')); }, 5_000);
      child.on('message', message => messages.push(message));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); resolveDone(); });
    });
    assert.deepEqual(messages, [{ type: 'startup_error', code }]);
  }
  await start();
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await rm(manifest);
  await start('SDK_API_UNSUPPORTED');
  assert.equal(await readFile(marker, 'utf8'), 'synthetic SDK imported', 'absence control must reach SDK import, without reading auth or invoking a provider');
});

test('explicit auth path is required and forwarded before runtime creation', async () => {
  const now = 1_000;
  const baseEnv = { AYLACHI_DEV_STATE_ROOT: '/private/app', AYLACHI_SDK_ROOT: '/trusted/sdk', AYLACHI_DEV_DEADLINE_MS: String(now + 10_000) };
  assert.throws(() => parseWorkerEnvironment(baseEnv, now), /HOST_START_FAILED/);
  assert.throws(() => parseWorkerEnvironment({ ...baseEnv, AYLACHI_DEV_AUTH_PATH: 'relative/auth.json' }, now), /HOST_START_FAILED/);

  const calls = [];
  const marker = { synthetic: true };
  const fakeSdk = { ModelRuntime: { create(options) { calls.push(options); return Promise.resolve(marker); } } };
  assert.throws(() => createWorkerModelRuntime(fakeSdk, undefined), /HOST_START_FAILED/);
  assert.throws(() => createWorkerModelRuntime(fakeSdk, 'relative/auth.json'), /HOST_START_FAILED/);
  assert.equal(calls.length, 0, 'invalid paths must not create a runtime');
  const authPath = '/private/sealed/auth.json';
  assert.strictEqual(await createWorkerModelRuntime(fakeSdk, authPath), marker);
  assert.deepEqual(calls, [{ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false }]);
});

test('factory uses canonical isolated adapter and floors remaining deadline for AbortSignal.timeout', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const h = fixture();
  const now = () => 1_000.75;
  const deadlineEpochMs = 1_200;
  const timeout = AbortSignal.timeout;
  const delays = [];
  AbortSignal.timeout = ms => { delays.push(ms); return timeout(ms); };
  t.after(() => { AbortSignal.timeout = timeout; });

  const adapter = makeAdapter(h, paths, deadlineEpochMs, 2, now);
  const result = await adapter.prompt('session-a', 'synthetic private prompt');
  assert.equal(result.text, 'Synthetic response.');
  assert.deepEqual(delays, [199]);
  assert.ok(Number.isInteger(delays[0]) && delays[0] > 0 && delays[0] <= deadlineEpochMs - now());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.maxRetries, 0);
  assert.equal(h.calls[0].options.signal.aborted, false);
  assert.deepEqual(h.sessions[0].tools, []);
  assert.deepEqual(h.settings[0], { retry: { enabled: false }, compaction: { enabled: false } });
  assert.equal(h.loaderOptions[0].noExtensions, true);
  assert.equal(h.loaderOptions[0].noSkills, true);
  assert.equal(h.loaderOptions[0].noContextFiles, true);
  const budget = JSON.parse(await readFile(join(paths.root, 'live-budget.json'), 'utf8'));
  assert.deepEqual(budget, { schemaVersion: 1, deadlineEpochMs, maxSdkCalls: 2, sdkCallsStarted: 1 });
  assert.equal(JSON.stringify(budget).includes('synthetic private prompt'), false);
  h.sessions[0].controller.abort();
  assert.equal(h.calls[0].options.signal.aborted, true, 'caller abort propagates through deadline signal');
  await adapter.shutdown();
});

test('durable call ceiling survives adapter recreation and never auto-retries', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const deadlineEpochMs = Date.now() + 60_000;
  const first = fixture();
  const adapter1 = makeAdapter(first, paths, deadlineEpochMs, 2, Date.now);
  await adapter1.prompt('first-session', 'synthetic one');
  await adapter1.shutdown();

  const second = fixture();
  const adapter2 = makeAdapter(second, paths, deadlineEpochMs, 2, Date.now);
  await adapter2.prompt('second-session', 'synthetic two');
  await assert.rejects(adapter2.prompt('third-session', 'synthetic three'), /SDK_CALL_LIMIT_REACHED/);
  assert.equal(first.calls.length + second.calls.length, 2);
  assert.ok([...first.calls, ...second.calls].every(call => call.options.maxRetries === 0));
  assert.equal(JSON.parse(await readFile(join(paths.root, 'live-budget.json'), 'utf8')).sdkCallsStarted, 2);
  await adapter2.shutdown();
});

test('pinned SDK completes a no-tool synthetic turn and persists native history', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const expectedText = 'Synthetic successful no-tool response.';
  let streams = 0;
  const modelRuntime = {
    getModel: () => model,
    getAvailable: async () => [model],
    hasConfiguredAuth: () => true,
    streamSimple(target, context, options) {
      assert.equal(target.provider, 'openai-codex');
      assert.equal(target.id, 'gpt-6-luna');
      assert.equal(options.reasoning, 'low');
      streams++;
      const stream = createAssistantMessageEventStream();
      const empty = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: 'stop', timestamp: Date.now() };
      const final = { ...empty, content: [{ type: 'text', text: expectedText }] };
      stream.push({ type: 'start', partial: empty });
      stream.push({ type: 'text_start', contentIndex: 0, partial: empty });
      stream.push({ type: 'text_end', contentIndex: 0, content: expectedText, partial: final });
      stream.push({ type: 'done', reason: 'stop', message: final });
      return stream;
    },
  };
  let session;
  const observedSdk = new Proxy(sdk, {
    get(target, property, receiver) {
      if (property === 'createAgentSessionFromServices') return async options => {
        assert.deepEqual(options.tools, []);
        const created = await target.createAgentSessionFromServices(options);
        session = created.session;
        return created;
      };
      return Reflect.get(target, property, receiver);
    },
  });
  const adapter = createWorkerAdapter({ sdk: observedSdk, modelRuntime, model, ...paths, deadlineEpochMs: Date.now() + 60_000 });
  try {
    const result = await adapter.prompt('fixture-session', 'synthetic no-tool request');
    assert.equal(result.text, expectedText);
    assert.equal(streams, 1);
    assert.deepEqual(session.getActiveToolNames(), []);
    const history = await readFile(result.nativeSessionFile, 'utf8');
    assert.match(history, /synthetic no-tool request/);
    assert.match(history, /Synthetic successful no-tool response/);
    const budget = JSON.parse(await readFile(join(paths.root, 'live-budget.json'), 'utf8'));
    assert.equal(budget.sdkCallsStarted, 1);
  } finally { await adapter.shutdown(); }
});

test('explicit model settings apply to the next turn without recreating the session', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const alternate = { ...model, id: 'gpt-reasoning-next', name: 'Synthetic alternate reasoning model' };
  const calls = [];
  const modelRuntime = {
    getModel: () => model, getAvailable: async () => [model, alternate], hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: 'oauth', source: 'synthetic model-switch fixture' }),
    streamSimple(target, context, options) {
      calls.push({ id: target.id, reasoning: options.reasoning });
      const stream = createAssistantMessageEventStream();
      const empty = { role: 'assistant', content: [], api: target.api, provider: target.provider, model: target.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: 'stop', timestamp: Date.now() };
      const final = { ...empty, content: [{ type: 'text', text: `applied:${target.id}:${options.reasoning}` }] };
      stream.push({ type: 'start', partial: empty });
      stream.push({ type: 'text_start', contentIndex: 0, partial: empty });
      stream.push({ type: 'text_end', contentIndex: 0, content: final.content[0].text, partial: final });
      stream.push({ type: 'done', reason: 'stop', message: final });
      return stream;
    },
  };
  const adapter = createWorkerAdapter({ sdk, modelRuntime, model, models: [model, alternate], ...paths, deadlineEpochMs: Date.now() + 60_000 });
  try {
    const first = await adapter.prompt('fixture-session', 'use alternate', { turnId: 'turn-alternate',
      model: { provider: alternate.provider, modelId: alternate.id, reasoning: 'high' } });
    assert.equal(first.text, 'applied:gpt-reasoning-next:high');
    const second = await adapter.prompt('fixture-session', 'return to default', { turnId: 'turn-default',
      model: { provider: model.provider, modelId: model.id, reasoning: 'low' } });
    assert.equal(second.text, 'applied:gpt-6-luna:low');
    assert.deepEqual(calls, [{ id: alternate.id, reasoning: 'high' }, { id: model.id, reasoning: 'low' }]);
    assert.equal(first.nativeSessionFile, second.nativeSessionFile);
    await assert.rejects(adapter.prompt('fixture-session', 'forbidden model', { turnId: 'turn-forbidden',
      model: { provider: model.provider, modelId: 'not-authorized', reasoning: 'low' } }), /invalid turn context/);
    assert.equal(calls.length, 2);
  } finally { await adapter.shutdown(); }
});

test('invalid or symlinked durable budgets fail closed; valid existing count is preserved', async t => {
  const roots = [];
  t.after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
  const deadlineEpochMs = Date.now() + 60_000;
  for (const contents of ['null', 'false', '0', '{corrupt']) {
    const paths = await makeRoot(); roots.push(paths.root);
    const target = join(paths.root, 'live-budget.json');
    await writeFile(target, contents, { mode: 0o600 });
    const h = fixture();
    assert.throws(() => makeAdapter(h, paths, deadlineEpochMs, 2, Date.now), /LIVE_BUDGET_INVALID/);
    assert.equal(await readFile(target, 'utf8'), contents, 'corrupt budget is not overwritten');
  }
  const linked = await makeRoot(); roots.push(linked.root);
  const outside = join(linked.root, 'outside.json');
  await writeFile(outside, 'do-not-follow', { mode: 0o600 });
  await symlink(outside, join(linked.root, 'live-budget.json'));
  assert.throws(() => makeAdapter(fixture(), linked, deadlineEpochMs, 2, Date.now), /LIVE_BUDGET_INVALID/);
  assert.equal(await readFile(outside, 'utf8'), 'do-not-follow');

  const exposed = await makeRoot(); roots.push(exposed.root);
  await writeFile(join(exposed.root, 'live-budget.json'), JSON.stringify({ schemaVersion: 1, deadlineEpochMs, maxSdkCalls: 2, sdkCallsStarted: 0 }), { mode: 0o644 });
  assert.throws(() => makeAdapter(fixture(), exposed, deadlineEpochMs, 2, Date.now), /LIVE_BUDGET_INVALID/);
  const nonFile = await makeRoot(); roots.push(nonFile.root);
  await mkdir(join(nonFile.root, 'live-budget.json'), { mode: 0o700 });
  assert.throws(() => makeAdapter(fixture(), nonFile, deadlineEpochMs, 2, Date.now), /LIVE_BUDGET_INVALID/);

  const persisted = await makeRoot(); roots.push(persisted.root);
  await writeFile(join(persisted.root, 'live-budget.json'), JSON.stringify({ schemaVersion: 1, deadlineEpochMs, maxSdkCalls: 2, sdkCallsStarted: 1 }), { mode: 0o600 });
  const h = fixture();
  const adapter = makeAdapter(h, persisted, deadlineEpochMs, 2, Date.now);
  assert.equal(JSON.parse(await readFile(join(persisted.root, 'live-budget.json'), 'utf8')).sdkCallsStarted, 1);
  await adapter.prompt('existing-count', 'synthetic continuation');
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(await readFile(join(persisted.root, 'live-budget.json'), 'utf8')).sdkCallsStarted, 2);
  await adapter.shutdown();
});

test('expired deadline rejects before durable count or SDK dispatch', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  let current = 1_000;
  const h = fixture();
  const adapter = makeAdapter(h, paths, 1_200, 3, () => current);
  await adapter.prompt('session-a', 'synthetic one');
  current = 1_200;
  await assert.rejects(adapter.prompt('session-b', 'synthetic late'), /WORKER_DEADLINE_EXPIRED/);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(await readFile(join(paths.root, 'live-budget.json'), 'utf8')).sdkCallsStarted, 1);
  await adapter.shutdown();
});
