import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createPiAdapter } from '../agent-host/pi-adapter.mjs';
import { sdk, Type, model } from '../agent-host/tests/fixture-runtime.mjs';
import { createBazaReader } from '../projects/baza-reader.mjs';
import { createProjectContextTool } from '../projects/context-tool.mjs';

const sdkRoot = resolve(process.env.AYLACHI_SDK_ROOT);
const nodeModules = resolve(sdkRoot, '../..');
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(nodeModules, '@earendil-works/pi-ai/dist/index.js')).href);

function assistant(content, stopReason) {
  return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason, timestamp: Date.now() };
}

function syntheticRuntime({ reopen = false, observed = [], hostile = false, seenToolResults = [] } = {}) {
  let sequence = 0;
  let providerCalls = 0;
  return {
    getAvailable: async () => [model], getModel: () => model, hasConfiguredAuth: () => true,
    streamSimple(_selected, context) {
      providerCalls++;
      const stream = createAssistantMessageEventStream();
      const empty = assistant([], 'stop');
      stream.push({ type: 'start', partial: empty });
      if (context.messages.at(-1)?.role === 'toolResult') {
        const toolResult = context.messages.at(-1);
        seenToolResults.push(structuredClone(toolResult));
        const resultText = toolResult.content.map(item => item.text ?? '').join('');
        const message = assistant([{ type: 'text', text: `received:${resultText}` }], 'stop');
        stream.push({ type: 'text_start', contentIndex: 0, partial: empty });
        stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
      } else if (!reopen) {
        const call = { type: 'toolCall', id: `context-call-${++sequence}`, name: 'project_context', arguments: hostile
          ? { query: 'overview', projectId: 'project-beta' }
          : { query: 'overview' } };
        const message = assistant([call], 'toolUse');
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message });
        stream.push({ type: 'done', reason: 'toolUse', message });
      } else {
        observed.push(structuredClone(context.messages));
        const message = assistant([{ type: 'text', text: 'reopened' }], 'stop');
        stream.push({ type: 'text_start', contentIndex: 0, partial: empty });
        stream.push({ type: 'text_end', contentIndex: 0, content: 'reopened', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
      }
      return stream;
    },
    complete: async () => { throw new Error('UNEXPECTED_PROVIDER_COMPLETE'); },
    get providerCalls() { return providerCalls; },
  };
}

function loaderFactory(tool) {
  return ({ sdk: actualSdk, cwd, agentDir, settingsManager }) => new actualSdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, extensionFactories: [pi => pi.registerTool(tool)],
  });
}

const bindings = {
  alpha: { projectId: 'project-alpha', cardId: 'card-alpha', sessionId: 'session-alpha', commandId: 'command-alpha', bazaPrefix: '10 Проекты/Alpha/' },
  beta: { projectId: 'project-beta', cardId: 'card-beta', sessionId: 'session-beta', commandId: 'command-beta', bazaPrefix: '10 Проекты/Beta/' },
};
const syntheticNotes = {
  alpha: { path: '10 Проекты/Alpha/state.md', text: 'ALPHA_ONLY_SYNTHETIC_NOTE' },
  beta: { path: '10 Проекты/Beta/state.md', text: 'BETA_ONLY_SYNTHETIC_NOTE' },
};
const BAZA_PYTHON = '/usr/bin/python3';
const BAZA_HELPER = '/home/ayla/.pi/agent/scripts/ayla_pi_baza.py';
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const helperArg = path => Buffer.from(JSON.stringify({ path }), 'utf8').toString('base64');

test('actual Pi SDK runs project_context in independent native sessions and reopens isolated histories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-project-context-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'cwd');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const activeBinding = new AsyncLocalStorage();
  let bindingCalls = 0, rpcArrivals = 0, activeRpc = 0, maxActiveRpc = 0;
  let barrierSettled = false, finishBarrier, barrierTimer;
  const rpcBarrier = new Promise(resolve => {
    finishBarrier = value => {
      if (barrierSettled) return;
      barrierSettled = true;
      clearTimeout(barrierTimer);
      resolve(value);
    };
    barrierTimer = setTimeout(() => finishBarrier(false), 4000);
  });
  const authorizationCalls = [];
  const rpcCalls = [];
  const transportCalls = [];
  const boundaryEvents = [];
  const sdkEvents = [];
  const boundReaders = new Map(Object.entries(bindings).map(([label, binding]) => {
    const note = syntheticNotes[label];
    return [binding.projectId, createBazaReader({
      projectId: binding.projectId,
      bazaPrefix: binding.bazaPrefix,
      notePaths: [note.path],
      enabled: true,
      execFileForTest: async (file, args, options) => {
        const reply = { path: note.path, content: note.text, sha256: sha256(note.text) };
        transportCalls.push({
          projectId: binding.projectId, file, args: [...args], reply,
          options: { cwd: options.cwd, shell: options.shell, timeout: options.timeout,
            maxBuffer: options.maxBuffer, env: options.env, signal: options.signal },
        });
        boundaryEvents.push({ kind: 'transport', projectId: binding.projectId });
        return { stdout: JSON.stringify(reply), stderr: '' };
      },
    })];
  }));
  const toolResults = [];
  const tool = createProjectContextTool({
    Type,
    getBinding: toolCallId => {
      bindingCalls++;
      assert.match(toolCallId, /^context-call-/);
      const current = activeBinding.getStore();
      assert.ok(current, 'binding is provided by the trusted host runner');
      return current;
    },
    authorize: descriptor => {
      const current = activeBinding.getStore();
      authorizationCalls.push(descriptor);
      boundaryEvents.push({ kind: 'authorize', projectId: descriptor.target.projectId });
      return descriptor.operation === 'project.context.read' && descriptor.permission === 'read' &&
        descriptor.target.projectId === current.projectId && descriptor.target.cardId === current.cardId &&
        descriptor.target.sessionId === current.sessionId && descriptor.commandId === current.commandId;
    },
    readProjectContext: async (projectId, query, signal) => {
      rpcCalls.push({ projectId, query, signalAborted: signal?.aborted === true });
      boundaryEvents.push({ kind: 'context', projectId });
      activeRpc++;
      maxActiveRpc = Math.max(maxActiveRpc, activeRpc);
      if (++rpcArrivals === 2) finishBarrier(true);
      try {
        if (!await rpcBarrier) throw new Error('RPC_BARRIER_TIMEOUT');
        const reader = boundReaders.get(projectId);
        if (!reader) throw new Error('UNBOUND_PROJECT');
        return await reader.readProjectContext(projectId, query, signal);
      } finally { activeRpc--; }
    },
  });
  const runtime = syntheticRuntime({ seenToolResults: toolResults });
  let adapter = createPiAdapter({ sdk, modelRuntime: runtime, model, cwd, root: join(root, 'pi'),
    toolDefinitions: [tool], resourceLoaderFactory: loaderFactory(tool),
    onEvent: event => sdkEvents.push(event) });
  let hostileAdapter = null;
  try {
    const sessions = Object.entries(bindings);
    const results = await Promise.all(sessions.map(([, binding]) =>
      activeBinding.run(binding, () => adapter.prompt(binding.sessionId, 'Read this project context.'))));
    for (let index = 0; index < sessions.length; index++) {
      const [label, binding] = sessions[index];
      assert.ok(results[index].text.includes(label === 'alpha' ? 'ALPHA_ONLY_SYNTHETIC_NOTE' : 'BETA_ONLY_SYNTHETIC_NOTE'));
      assert.ok(results[index].nativeSessionFile.startsWith(join(root, 'pi', 'sessions', binding.sessionId)));
    }
    assert.deepEqual(rpcCalls.map(call => call.projectId).sort(), ['project-alpha', 'project-beta']);
    assert.ok(rpcCalls.every(call => call.query === 'overview' && !call.signalAborted));
    assert.equal(rpcArrivals, 2);
    assert.equal(maxActiveRpc, 2, 'the deterministic RPC barrier proves both project calls overlapped');
    assert.equal(bindingCalls, 2);
    assert.deepEqual(authorizationCalls.map(call => call.target.projectId).sort(), ['project-alpha', 'project-beta']);
    assert.ok(sdkEvents.some(event => event.type === 'tool_execution_end' && event.toolName === 'project_context' && !event.isError));
    assert.equal(runtime.providerCalls, 4, 'synthetic model only: tool call and final answer for each native session');
    assert.equal(JSON.stringify(rpcCalls).includes('BETA_ONLY_SYNTHETIC_NOTE'), false, 'the tool transport never receives another project’s note');
    assert.equal(JSON.stringify(rpcCalls).includes('ALPHA_ONLY_SYNTHETIC_NOTE'), false, 'the tool transport records only project IDs and queries');
    assert.equal(transportCalls.length, 2, 'only the two explicitly injected synthetic transports ran');
    for (const call of transportCalls) {
      const label = call.projectId === 'project-alpha' ? 'alpha' : 'beta';
      const note = syntheticNotes[label];
      assert.equal(call.file, BAZA_PYTHON);
      assert.deepEqual(call.args, [BAZA_HELPER, 'read', helperArg(note.path)]);
      assert.deepEqual(call.reply, { path: note.path, content: note.text, sha256: sha256(note.text) });
      assert.equal(call.options.cwd, '/');
      assert.equal(call.options.shell, false);
      assert.equal(call.options.timeout, 15_000);
      assert.equal(call.options.maxBuffer, 1024 * 1024);
      assert.deepEqual(call.options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
    }
    for (const projectId of ['project-alpha', 'project-beta']) {
      const authIndex = boundaryEvents.findIndex(event => event.kind === 'authorize' && event.projectId === projectId);
      const contextIndex = boundaryEvents.findIndex(event => event.kind === 'context' && event.projectId === projectId);
      const transportIndex = boundaryEvents.findIndex(event => event.kind === 'transport' && event.projectId === projectId);
      assert.ok(authIndex >= 0 && authIndex < contextIndex && contextIndex < transportIndex,
        `${projectId} must authorize before reaching the injected helper transport`);
    }
    assert.equal(toolResults.length, 2);
    const sdkResponses = toolResults.map(result => JSON.parse(result.content.map(item => item.text ?? '').join('')));
    for (const [label, binding] of Object.entries(bindings)) {
      assert.deepEqual(sdkResponses.find(response => response.projectId === binding.projectId), {
        projectId: binding.projectId,
        excerpts: [{ path: syntheticNotes[label].path, text: syntheticNotes[label].text }],
      });
    }

    await adapter.shutdown();
    adapter = null;
    const reopenedContexts = [];
    const reopenedRuntime = syntheticRuntime({ reopen: true, observed: reopenedContexts });
    adapter = createPiAdapter({ sdk, modelRuntime: reopenedRuntime, model, cwd, root: join(root, 'pi'),
      toolDefinitions: [tool], resourceLoaderFactory: loaderFactory(tool) });
    for (const [label, binding] of Object.entries(bindings)) {
      const result = await activeBinding.run(binding, () => adapter.prompt(binding.sessionId, 'Reopen check.'));
      assert.equal(result.text, 'reopened');
    }
    assert.equal(reopenedContexts.length, 2);
    const alphaHistory = JSON.stringify(reopenedContexts[0]);
    const betaHistory = JSON.stringify(reopenedContexts[1]);
    assert.ok(alphaHistory.includes('ALPHA_ONLY_SYNTHETIC_NOTE'));
    assert.equal(alphaHistory.includes('BETA_ONLY_SYNTHETIC_NOTE'), false);
    assert.ok(betaHistory.includes('BETA_ONLY_SYNTHETIC_NOTE'));
    assert.equal(betaHistory.includes('ALPHA_ONLY_SYNTHETIC_NOTE'), false);
    assert.equal(reopenedRuntime.providerCalls, 2, 'reopen verification still uses only the synthetic runtime');

    bindingCalls = 0;
    authorizationCalls.length = 0;
    rpcCalls.length = 0;
    transportCalls.length = 0;
    boundaryEvents.length = 0;
    const hostileToolResults = [];
    const hostileEvents = [];
    const hostileRuntime = syntheticRuntime({ hostile: true, seenToolResults: hostileToolResults });
    hostileAdapter = createPiAdapter({ sdk, modelRuntime: hostileRuntime, model, cwd, root: join(root, 'hostile-pi'),
      toolDefinitions: [tool], resourceLoaderFactory: loaderFactory(tool),
      onEvent: event => hostileEvents.push(event) });
    const hostileBinding = { ...bindings.alpha, cardId: 'card-hostile', sessionId: 'session-hostile', commandId: 'command-hostile' };
    const hostileResult = await activeBinding.run(hostileBinding, () => hostileAdapter.prompt(hostileBinding.sessionId, 'Try to switch projects.'));
    assert.equal(typeof hostileResult.text, 'string');
    assert.ok(hostileEvents.some(event => event.type === 'tool_execution_end' && event.toolName === 'project_context' && event.isError === true),
      JSON.stringify({ hostileEvents, hostileToolResults }));
    assert.equal(bindingCalls, 0, 'SDK/schema or tool input validation must reject before resolving trusted binding');
    assert.equal(authorizationCalls.length, 0, 'hostile model arguments must not reach authorization');
    assert.equal(rpcCalls.length, 0, 'hostile model arguments must not reach the project-context boundary');
    assert.equal(transportCalls.length, 0, 'hostile model arguments must not reach the injected helper transport');
    assert.equal(boundaryEvents.length, 0, 'hostile model arguments must have no authorization or transport effects');
  } finally {
    finishBarrier(false);
    await Promise.all([adapter?.shutdown(), hostileAdapter?.shutdown()]);
  }
});
