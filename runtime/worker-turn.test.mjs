import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createWorkerAdapter } from './pi-worker.mjs';
import { loadRestoredSessionFiles, RESTORED_SESSION_FILES_NAME } from './restored-session-files.mjs';
import { sdk, Type } from '../agent-host/tests/fixture-runtime.mjs';

const model = { id: 'gpt-6-luna', name: 'Synthetic worker-turn fixture', api: 'openai-codex-responses', provider: 'openai-codex', reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const sdkRoot = resolve(process.env.AYLACHI_SDK_ROOT);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(sdkRoot, '../..', '@earendil-works/pi-ai/dist/utils/event-stream.js')).href);

function assistant(content, stopReason) {
  return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason, timestamp: Date.now() };
}
function contentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : '';
}
function toolNames(context) {
  return context.messages.flatMap(message => message.role === 'system' ? (message.toolsAdded ?? []).map(tool => tool.name) : []);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function syntheticRuntime({ stalePrompts = new Set(), failurePrompts = new Set(), waitPrompts = new Set() } = {}) {
  const calls = [];
  const waits = new Map();
  const stale = new Map();
  let sequence = 0;
  const modelRuntime = {
    getModel: () => model,
    getAvailable: async () => [model],
    hasConfiguredAuth: () => true,
    streamSimple(target, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const prompt = contentText([...context.messages].reverse().find(message => message.role === 'user')?.content);
      calls.push({ target, context, options, prompt, tools: toolNames(context) });
      const end = message => stream.push({ type: message.stopReason === 'error' || message.stopReason === 'aborted' ? 'error' : 'done', reason: message.stopReason, ...(message.stopReason === 'error' || message.stopReason === 'aborted' ? { error: message } : { message }) });
      if (last?.role === 'toolResult') {
        if (failurePrompts.has(prompt)) {
          const failed = { ...assistant([], 'error'), errorMessage: 'synthetic provider failure' };
          end(failed);
        } else if (waitPrompts.has(prompt)) {
          const wait = waits.get(prompt);
          wait?.resolve();
          const abort = () => end({ ...assistant([], 'aborted'), errorMessage: 'synthetic abort' });
          if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
        } else {
          end(assistant([{ type: 'text', text: 'Synthetic worker response.' }], 'stop'));
        }
      } else {
        const selected = prompt.includes('session-a') ? 'turn_tool_a' : prompt.includes('session-b') ? 'turn_tool_b' : undefined;
        if (!selected) end(assistant([{ type: 'text', text: 'Synthetic no-tool response.' }], 'stop'));
        else end(assistant([{ type: 'toolCall', id: `turn-call-${++sequence}`, name: selected, arguments: { text: prompt } }], 'toolUse'));
      }
      return stream;
    },
  };
  return {
    modelRuntime, calls, stale, waits,
    waitFor(prompt) { if (!waits.has(prompt)) waits.set(prompt, deferred()); return waits.get(prompt).promise; },
    createTool(name, getTurnContext) {
      return { name, label: name, description: 'Synthetic turn-context probe', parameters: Type.Object({ text: Type.String() }),
        execute: async (_id, args) => {
          const context = getTurnContext();
          if (context !== undefined) assert.ok(Object.isFrozen(context));
          calls.push({ toolExecution: args.text, turnContext: context });
          if (stalePrompts.has(args.text)) {
            const gate = deferred();
            let finish;
            const read = new Promise(resolve => { finish = resolve; });
            setImmediate(async () => { await gate.promise; finish(getTurnContext()); });
            stale.set(args.text, { release: gate.resolve, read });
          }
          return { content: [{ type: 'text', text: args.text }] };
        },
      };
    },
  };
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-worker-turn-'));
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { mode: 0o700 });
  return { root, cwd };
}
const create = (runtime, paths, deadlineEpochMs, extra = {}) => createWorkerAdapter({
  sdk, modelRuntime: runtime.modelRuntime, model, ...paths, deadlineEpochMs, maxSdkCalls: 20, ...extra,
});
async function releaseStale(runtime, prompt) {
  const item = runtime.stale.get(prompt);
  assert.ok(item, `missing detached callback for ${prompt}`);
  item.release();
  assert.equal(await item.read, undefined, `stale turn context leaked for ${prompt}`);
}

test('private restored manifest wires exact relocated SDK history through worker adapter', async t => {
  const source = await makeRoot(), destination = await makeRoot();
  const deadlineEpochMs = Date.now() + 120_000;
  t.after(() => Promise.all([source, destination].map(paths => rm(paths.root, { recursive: true, force: true }))));
  const firstRuntime = syntheticRuntime();
  const first = create(firstRuntime, source, deadlineEpochMs);
  let original;
  try { original = await first.prompt('relocated', 'original context marker'); }
  finally { await first.shutdown(); }
  const basename = original.nativeSessionFile.split('/').at(-1);
  await cp(join(source.root, 'pi'), join(destination.root, 'pi'), { recursive: true, force: false, errorOnExist: true });
  const nativeFile = join(destination.root, 'pi', 'sessions', 'relocated', basename);
  await chmod(nativeFile, 0o600);
  await writeFile(join(destination.root, RESTORED_SESSION_FILES_NAME), JSON.stringify({ format: 1, sessions: { relocated: basename } }), { mode: 0o600 });
  const bindings = await loadRestoredSessionFiles(destination.root);
  const resumedRuntime = syntheticRuntime();
  const resumed = create(resumedRuntime, destination, deadlineEpochMs, { restoredSessionFiles: bindings });
  try {
    const reply = await resumed.prompt('relocated', 'continuation marker');
    assert.equal(reply.nativeSessionFile, nativeFile);
    assert.ok(resumedRuntime.calls.some(call => call.context?.messages.some(message => contentText(message.content).includes('original context marker'))));
  } finally { await resumed.shutdown(); }
  const after = await readFile(nativeFile, 'utf8');
  const reopenedRuntime = syntheticRuntime();
  const reopened = create(reopenedRuntime, destination, deadlineEpochMs, { restoredSessionFiles: await loadRestoredSessionFiles(destination.root) });
  try {
    assert.equal(await readFile(nativeFile, 'utf8'), after, 'reopen alone cannot replay or append');
    await reopened.prompt('relocated', 'second continuation');
    assert.ok(reopenedRuntime.calls.some(call => call.context?.messages.some(message => contentText(message.content).includes('continuation marker'))));
  } finally { await reopened.shutdown(); }
});

test('actual SDK scopes concurrent sessions and fresh turns; tools receive only their active turn context', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(paths.cwd, '.pi', 'skills', 'decoy'), { recursive: true }),
    mkdir(join(paths.root, 'pi', 'agent', 'skills', 'decoy'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(paths.cwd, '.pi', 'skills', 'decoy', 'SKILL.md'), '---\nname: decoy\ndescription: PROJECT_AMBIENT_MARKER\n---\n'),
    writeFile(join(paths.root, 'pi', 'agent', 'skills', 'decoy', 'SKILL.md'), '---\nname: decoy\ndescription: AGENT_AMBIENT_MARKER\n---\n'),
  ]);
  const runtime = syntheticRuntime({ stalePrompts: new Set(['session-a first', 'session-a second', 'session-a failure', 'session-a cancel', 'session-a shutdown']) });
  const factoryCalls = [];
  const selections = [];
  const adapter = create(runtime, paths, Date.now() + 120_000, {
    toolDefinitionsFactory: async args => {
      factoryCalls.push(args.sessionId);
      assert.deepEqual(Object.keys(args).sort(), ['agentDir', 'cwd', 'getTurnContext', 'sdk', 'sessionId']);
      assert.strictEqual(args.sdk, sdk);
      assert.equal(args.cwd, paths.cwd);
      assert.equal(args.agentDir, join(paths.root, 'pi', 'agent'));
      assert.equal(typeof args.getTurnContext, 'function');
      selections.push([args.sessionId, args.getTurnContext]);
      await new Promise(resolve => setImmediate(resolve));
      if (args.sessionId === 'session-a') return [runtime.createTool('turn_tool_a', args.getTurnContext)];
      if (args.sessionId === 'session-b') return [runtime.createTool('turn_tool_b', args.getTurnContext)];
      return [];
    },
  });
  t.after(() => adapter.shutdown().catch(() => {}));

  const [a1, b1, empty] = await Promise.all([
    adapter.prompt('session-a', 'session-a first', { turnId: 'turn-A.1:alpha' }),
    adapter.prompt('session-b', 'session-b first', { turnId: 'turn-B.1:beta' }),
    adapter.prompt('session-empty', 'session-empty no-tool', { turnId: 'turn-empty' }),
  ]);
  assert.equal(a1.text, 'Synthetic worker response.');
  assert.equal(b1.text, 'Synthetic worker response.');
  assert.equal(empty.text, 'Synthetic no-tool response.');
  assert.deepEqual(factoryCalls.sort(), ['session-a', 'session-b', 'session-empty']);
  const executions = runtime.calls.filter(call => Object.hasOwn(call, 'toolExecution'));
  assert.deepEqual(executions.map(call => call.turnContext).sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
    { sessionId: 'session-a', turnId: 'turn-A.1:alpha' },
    { sessionId: 'session-b', turnId: 'turn-B.1:beta' },
  ]);
  assert.ok(executions.every(call => Object.isFrozen(call.turnContext)));
  assert.deepEqual(runtime.calls.find(call => call.prompt === 'session-a first')?.tools, ['turn_tool_a']);
  assert.deepEqual(runtime.calls.find(call => call.prompt === 'session-b first')?.tools, ['turn_tool_b']);
  assert.deepEqual(runtime.calls.find(call => call.prompt === 'session-empty no-tool')?.tools, []);
  assert.doesNotMatch(JSON.stringify(runtime.calls.filter(call => call.target).map(call => call.context)), /turn-A\.1:alpha|turn-B\.1:beta|PROJECT_AMBIENT_MARKER|AGENT_AMBIENT_MARKER/);

  await adapter.prompt('session-a', 'session-a second', { turnId: 'turn-A2' });
  assert.equal(factoryCalls.length, 3, 'cached logical session reuses its selected tool');
  const latestA = runtime.calls.filter(call => call.toolExecution === 'session-a second');
  assert.deepEqual(latestA.map(call => call.turnContext), [{ sessionId: 'session-a', turnId: 'turn-A2' }]);
  await releaseStale(runtime, 'session-a first');
  await releaseStale(runtime, 'session-a second');
  assert.ok(selections.find(([id]) => id === 'session-a'));
  const budget = JSON.parse(await readFile(join(paths.root, 'live-budget.json'), 'utf8'));
  assert.equal(budget.sdkCallsStarted, runtime.calls.filter(call => call.target).length);
  assert.equal(budget.maxSdkCalls, 20);
  await adapter.shutdown();

  const restartRuntime = syntheticRuntime();
  const restarted = create(restartRuntime, paths, budget.deadlineEpochMs);
  try {
    await restarted.prompt('after-restart', 'ordinary no-tool continuation');
    const after = JSON.parse(await readFile(join(paths.root, 'live-budget.json'), 'utf8'));
    assert.equal(after.sdkCallsStarted, budget.sdkCallsStarted + 1, 'worker recreation must not reset durable budget');
  } finally { await restarted.shutdown(); }
});

test('missing context grants nothing; malformed turn options reject before SDK/model dispatch', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const runtime = syntheticRuntime();
  const adapter = create(runtime, paths, Date.now() + 60_000, {
    toolDefinitionsFactory: ({ getTurnContext }) => [runtime.createTool('turn_tool_a', getTurnContext)],
  });
  t.after(() => adapter.shutdown().catch(() => {}));
  await adapter.prompt('session-a', 'session-a no-context');
  assert.equal(runtime.calls.find(call => call.toolExecution === 'session-a no-context')?.turnContext, undefined);
  const beforeCalls = runtime.calls.filter(call => call.target).length;
  const beforeBudget = await readFile(join(paths.root, 'live-budget.json'), 'utf8');
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'turnId', { get() { getterCalls++; return 'valid'; } });
  const hidden = Object.defineProperty({}, 'turnId', { value: 'hidden-turn' });
  await assert.rejects(adapter.prompt('session-a', 'session-a hidden-context', hidden), /invalid turn context/);
  assert.equal(runtime.calls.filter(call => call.target).length, beforeCalls, 'non-enumerable turnId never reaches the model runtime');
  assert.equal(await readFile(join(paths.root, 'live-budget.json'), 'utf8'), beforeBudget, 'non-enumerable turnId does not change budget');
  const invalid = [null, [], { turnId: '' }, { turnId: 'slash/invalid' }, { turnId: 'valid', extra: true }, Object.create({ turnId: 'inherited' }), accessor, { [Symbol('extra')]: true, turnId: 'valid' }];
  for (const options of invalid) await assert.rejects(adapter.prompt('session-a', 'session-a invalid-context', options), /invalid turn context/);
  assert.equal(getterCalls, 0, 'accessor property is rejected without invoking it');
  assert.equal(runtime.calls.filter(call => call.target).length, beforeCalls, 'invalid contexts never reach the model runtime');
  assert.equal(await readFile(join(paths.root, 'live-budget.json'), 'utf8'), beforeBudget, 'invalid contexts do not consume or reset budget');
  await adapter.shutdown();
});

test('turn context is invalidated after provider rejection, cancellation, and shutdown', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const prompts = ['session-a failure', 'session-a cancel', 'session-a shutdown'];
  const runtime = syntheticRuntime({ stalePrompts: new Set(prompts), failurePrompts: new Set([prompts[0]]), waitPrompts: new Set(prompts.slice(1)) });
  const adapter = create(runtime, paths, Date.now() + 120_000, {
    toolDefinitionsFactory: ({ getTurnContext }) => [runtime.createTool('turn_tool_a', getTurnContext)],
  });
  t.after(() => adapter.shutdown().catch(() => {}));

  await assert.rejects(adapter.prompt('session-a', prompts[0], { turnId: 'turn-fail' }), /PROVIDER_FAILED/);
  await releaseStale(runtime, prompts[0]);

  const cancelPending = adapter.prompt('session-a', prompts[1], { turnId: 'turn-cancel' });
  const cancelRejected = assert.rejects(cancelPending, /CANCELLED/);
  await runtime.waitFor(prompts[1]);
  await adapter.cancel('session-a');
  await cancelRejected;
  await releaseStale(runtime, prompts[1]);

  const shutdownPending = adapter.prompt('session-a', prompts[2], { turnId: 'turn-shutdown' });
  const shutdownRejected = assert.rejects(shutdownPending, /CANCELLED/);
  await runtime.waitFor(prompts[2]);
  await adapter.shutdown();
  await shutdownRejected;
  await releaseStale(runtime, prompts[2]);
  assert.equal(runtime.calls.filter(call => call.target).length, JSON.parse(await readFile(join(paths.root, 'live-budget.json'), 'utf8')).sdkCallsStarted);
});

test('non-callable tool factory fails before budget initialization', async t => {
  const paths = await makeRoot();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  assert.throws(() => create(syntheticRuntime(), paths, Date.now() + 60_000, { toolDefinitionsFactory: {} }), /trusted function/);
  await assert.rejects(readFile(join(paths.root, 'live-budget.json')), { code: 'ENOENT' });
});
