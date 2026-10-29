import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createPiAdapter } from '../pi-adapter.mjs';
import { assertSdkManifest } from '../sdk-compat.mjs';
const sdkRoot = resolve(process.env.AYLACHI_SDK_ROOT ?? '');
assert.ok(sdkRoot, 'set AYLACHI_SDK_ROOT');
const dependencies = resolve(sdkRoot, '../..');
const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
const { Type } = await import(pathToFileURL(join(dependencies, 'typebox/build/index.mjs')).href);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dependencies, '@earendil-works/pi-ai/dist/index.js')).href);
const manifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
assertSdkManifest(manifest);
const model = { id: 'session-tools-fixture', name: 'Session tools synthetic', api: 'openai-completions', provider: 'synthetic', baseUrl: 'http://127.0.0.1/unused', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function assistant(content, stopReason) {
  return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason, timestamp: Date.now() };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : '';
}

function toolNamesFromContext(context) {
  return context.messages.flatMap(message => message.role === 'system' ? (message.toolsAdded ?? []).map(tool => tool.name) : []);
}

function recordingRuntime({ toolOnPrompt = () => undefined } = {}) {
  const calls = [];
  let sequence = 0;
  return {
    calls,
    getModel: () => model,
    getAvailable: async () => [model],
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: 'api_key', source: 'synthetic fixture' }),
    isUsingOAuth: () => false,
    streamSimple(_model, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const names = toolNamesFromContext(context);
      const promptText = contentText([...context.messages].reverse().find(message => message.role === 'user')?.content);
      calls.push({ last, names, context, promptText });
      if (last?.role === 'toolResult') {
        const message = assistant([{ type: 'text', text: 'fixture complete' }], 'stop');
        stream.push({ type: 'done', reason: 'stop', message });
      } else {
        const name = toolOnPrompt(promptText);
        if (name) {
          const message = assistant([{ type: 'toolCall', id: `tool-call-${++sequence}`, name, arguments: { text: 'safe fixture' } }], 'toolUse');
          stream.push({ type: 'done', reason: 'toolUse', message });
        } else {
          const message = assistant([{ type: 'text', text: 'fixture complete' }], 'stop');
          stream.push({ type: 'done', reason: 'stop', message });
        }
      }
      return stream;
    },
  };
}

function fixtureTool(name, onExecute = () => {}) {
  return { name, label: name, description: 'Safe synthetic tool', parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, args) => { onExecute(); return { content: [{ type: 'text', text: args.text }] }; } };
}

function isolatedLoader({ sdk: sdkArg, cwd, agentDir, settingsManager, toolDefinitions }) {
  return new sdkArg.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => { for (const tool of toolDefinitions) pi.registerTool(tool); }],
  });
}

test('factory selects per-session tools once; distinct concurrent sessions activate only their selection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-session-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), stateRoot = join(root, 'state');
  await Promise.all([
    mkdir(join(cwd, '.pi', 'skills', 'decoy'), { recursive: true }),
    mkdir(join(stateRoot, 'agent', 'skills', 'decoy'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(cwd, '.pi', 'skills', 'decoy', 'SKILL.md'), '---\nname: decoy\ndescription: AMBIENT_PROJECT_DECOY\n---\n'),
    writeFile(join(stateRoot, 'agent', 'skills', 'decoy', 'SKILL.md'), '---\nname: decoy\ndescription: AMBIENT_AGENT_DECOY\n---\n'),
  ]);
  const executions = [];
  const parentTool = fixtureTool('delegate_fixture', () => executions.push('parent'));
  const factoryCalls = [];
  const models = recordingRuntime({ toolOnPrompt: text => String(text).includes('parent session') ? 'delegate_fixture' : undefined });
  const adapter = createPiAdapter({ sdk, modelRuntime: models, model, root: stateRoot, cwd,
    toolDefinitionsFactory: async args => {
      factoryCalls.push(args.sessionId);
      await new Promise(resolve => setImmediate(resolve));
      return args.sessionId === 'parentSession' ? [parentTool] : [];
    },
  });
  const [parent, child] = await Promise.all([
    adapter.prompt('parentSession', 'parent session'),
    adapter.prompt('childSession', 'child session'),
  ]);
  assert.equal(parent.text, 'fixture complete');
  assert.equal(child.text, 'fixture complete');
  assert.deepEqual(factoryCalls.sort(), ['childSession', 'parentSession']);
  assert.deepEqual(executions, ['parent']);
  assert.deepEqual(models.calls.find(call => call.names?.includes('delegate_fixture'))?.names, ['delegate_fixture']);
  const childCall = models.calls.find(call => call.promptText === 'child session');
  assert.ok(childCall);
  assert.deepEqual(childCall.names, []);
  const allContext = JSON.stringify(models.calls.map(call => call.context));
  assert.doesNotMatch(allContext, /AMBIENT_(PROJECT|AGENT)_DECOY/);
  await adapter.prompt('parentSession', 'parent session again');
  await adapter.prompt('childSession', 'child session again');
  assert.equal(factoryCalls.length, 2, 'cached logical sessions reuse their selected tools');
  await adapter.shutdown();
});

test('resource-loader factory receives the same frozen selection used for SDK activation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-session-tools-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), stateRoot = join(root, 'state');
  await mkdir(cwd, { recursive: true });
  const source = [fixtureTool('selected_fixture', () => executions++)];
  let executions = 0;
  const models = recordingRuntime({ toolOnPrompt: () => 'selected_fixture' });
  let received;
  const adapter = createPiAdapter({ sdk, modelRuntime: models, model, root: stateRoot, cwd,
    toolDefinitionsFactory: () => source,
    resourceLoaderFactory: async args => {
      received = args.toolDefinitions;
      assert.deepEqual(Object.keys(args).sort(), ['agentDir', 'cwd', 'sdk', 'sessionId', 'settingsManager', 'toolDefinitions']);
      assert.equal(args.sessionId, 'selectedSession');
      assert.notStrictEqual(args.toolDefinitions, source);
      assert.ok(Object.isFrozen(args.toolDefinitions));
      assert.deepEqual(args.toolDefinitions.map(tool => tool.name), ['selected_fixture']);
      return isolatedLoader(args);
    },
  });
  const result = await adapter.prompt('selectedSession', 'selected tool');
  assert.equal(result.text, 'fixture complete');
  assert.deepEqual(received.map(tool => tool.name), ['selected_fixture']);
  assert.deepEqual(models.calls[0]?.names, ['selected_fixture']);
  assert.equal(executions, 1);
  await adapter.shutdown();
});

test('factory failures and invalid results clear pending cache without starting the SDK; retry works', async t => {
  const invalid = [
    ['factory rejection', () => { throw new Error('FACTORY_FAILED'); }],
    ['non-array', () => ({})],
    ['missing name', () => [{ execute() {} }]],
    ['missing execute', () => [{ name: 'named_only' }]],
    ['duplicate names', () => [fixtureTool('duplicate'), fixtureTool('duplicate')]],
  ];
  for (const [label, invalidFactory] of invalid) await t.test(label, async t2 => {
    const root = await mkdtemp(join(tmpdir(), 'aylachi-session-tools-invalid-'));
    t2.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, 'workspace'), stateRoot = join(root, 'state');
    await mkdir(cwd, { recursive: true });
    let factoryCalls = 0, modelCalls = 0, sdkStarts = 0;
    const instrumentedSdk = { ...sdk, createAgentSessionRuntime: (...args) => { sdkStarts++; return sdk.createAgentSessionRuntime(...args); } };
    const models = recordingRuntime();
    const original = models.streamSimple;
    models.streamSimple = (...args) => { modelCalls++; return original(...args); };
    const adapter = createPiAdapter({ sdk: instrumentedSdk, modelRuntime: models, model, root: stateRoot, cwd,
      toolDefinitionsFactory: () => ++factoryCalls === 1 ? invalidFactory() : [],
    });
    const expected = label === 'factory rejection' ? /FACTORY_FAILED/ : label === 'non-array' ? /return an array/ : label === 'duplicate names' ? /duplicate tool names/ : /named executable tools/;
    await assert.rejects(adapter.prompt('retrySession', 'first attempt'), expected);
    assert.equal(modelCalls, 0);
    assert.equal(sdkStarts, 0, 'factory failure must precede SDK session startup');
    const result = await adapter.prompt('retrySession', 'retry');
    assert.equal(result.text, 'fixture complete');
    assert.equal(factoryCalls, 2);
    assert.equal(modelCalls, 1);
    assert.equal(sdkStarts, 1);
    await adapter.shutdown();
  });
});

test('factory option rejects invalid configuration and ambiguous static tools', async () => {
  const base = { sdk, modelRuntime: recordingRuntime(), model, root: '/tmp/session-tools-config', cwd: '/tmp' };
  assert.throws(() => createPiAdapter({ ...base, toolDefinitionsFactory: {} }), /trusted function/);
  assert.throws(() => createPiAdapter({ ...base, toolDefinitions: [fixtureTool('static')], toolDefinitionsFactory: () => [] }), /mutually exclusive/);
});
