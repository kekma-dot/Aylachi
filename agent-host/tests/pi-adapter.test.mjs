import assert from 'node:assert/strict';
import { chmod, copyFile, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPiAdapter } from '../pi-adapter.mjs';

import { sdk, Type, model, runtime } from './fixture-runtime.mjs';

function observeRuntime(options) {
  const contexts = [];
  const base = runtime(options);
  return { contexts, modelRuntime: { ...base, streamSimple: (...args) => { contexts.push(args[1]); return base.streamSimple(...args); } } };
}

function echoTool(onExecute = () => {}) {
  return { name: 'fixture_echo', label: 'Fixture echo', description: 'Safe fixture', parameters: Type.Object({ text: Type.String() }), execute: async (_id, args) => { onExecute(); return { content: [{ type: 'text', text: args.text }] }; } };
}

function inertReadTool() {
  return { name: 'read', label: 'Fixture read', description: 'Inert test tool; no filesystem access', parameters: Type.Object({ path: Type.String() }), execute: async () => ({ content: [{ type: 'text', text: 'inert fixture read' }] }) };
}

function systemContextSections(contexts) {
  return contexts.flatMap(context => context.messages ?? [])
    .filter(message => message.role === 'system')
    .flatMap(message => [
      ...(typeof message.content === 'string' ? [message.content] : Array.isArray(message.content) ? message.content.map(part => part?.text) : []),
      ...Object.values(message.sections ?? {}),
    ])
    .filter(section => typeof section === 'string')
    .join('\n');
}

function systemPromptSections(contexts) {
  return contexts.flatMap(context => context.messages ?? [])
    .filter(message => message.role === 'system')
    .flatMap(message => Object.values(message.sections ?? {}))
    .filter(section => typeof section === 'string')
    .join('\n');
}

function modelUserText(contexts) {
  return contexts.flatMap(context => context.messages ?? [])
    .filter(message => message.role === 'user')
    .flatMap(message => typeof message.content === 'string' ? [message.content] : Array.isArray(message.content) ? message.content.map(part => part?.text) : [])
    .filter(text => typeof text === 'string')
    .join('\n');
}

function isolatedLoader({ sdk: actualSdk, cwd, agentDir, settingsManager, toolDefinitions, skillsOverride }) {
  return new actualSdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => { for (const tool of toolDefinitions) pi.registerTool(tool); }],
    ...(skillsOverride ? { skillsOverride } : {}),
  });
}

test('adapter runs actual SDK tool, restores native context, rejects invalid prompt, closes cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(join(cwd, '.pi', 'skills', 'project-decoy'), { recursive: true }),
    mkdir(join(stateRoot, 'agent', 'skills', 'global-decoy'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(cwd, '.pi', 'skills', 'project-decoy', 'SKILL.md'), '---\nname: project-decoy\ndescription: PROJECT_DECOY_MARKER\n---\nUnselected.\n'),
    writeFile(join(stateRoot, 'agent', 'skills', 'global-decoy', 'SKILL.md'), '---\nname: global-decoy\ndescription: GLOBAL_DECOY_MARKER\n---\nUnselected.\n'),
  ]);
  const events = []; let effects = 0;
  const tool = echoTool(() => effects++);
  const observed = observeRuntime();
  const options = { sdk, modelRuntime: observed.modelRuntime, model, root: stateRoot, cwd, toolDefinitions: [inertReadTool(), tool], onEvent: event => events.push(event) };
  const adapter = createPiAdapter(options);
  const result = await adapter.prompt('sessionA', 'marker session A');
  assert.equal(result.text, 'fixture complete'); assert.equal(effects, 1);
  assert.ok(events.some(event => event.sessionId === 'sessionA' && event.type === 'tool_execution_end'));
  assert.ok(events.some(event => event.toolCallId && event.toolName === 'fixture_echo'));
  assert.ok(events.some(event => event.type === 'turn_usage' && event.usage.totalTokens === 0 && event.usage.durationMs >= 1));
  assert.ok(observed.contexts.length > 0);
  assert.ok(observed.contexts.some(context => context.messages.some(message => message.toolsAdded?.some(tool => tool.name === 'fixture_echo'))),
    'custom tool must be declared in provider-visible system.toolsAdded');
  assert.ok(observed.contexts.flatMap(context => context.messages ?? []).some(message => message.role === 'system' && message.sections));
  assert.doesNotMatch(systemContextSections(observed.contexts), /project-decoy|global-decoy|DECOY_MARKER/);
  await adapter.prompt('sessionA', '/skill:project-decoy');
  assert.doesNotMatch(JSON.stringify(observed.contexts), /PROJECT_DECOY_MARKER|GLOBAL_DECOY_MARKER/);
  await assert.rejects(adapter.prompt('../escape', 'invalid'), /invalid session id/);
  await assert.rejects(adapter.prompt('sessionA', ''), /invalid prompt/);
  await adapter.shutdown(); await adapter.shutdown();
  await assert.rejects(adapter.prompt('sessionA', 'closed'), /HOST_CLOSED/);
  const restored = createPiAdapter({ ...options, modelRuntime: runtime() });
  const next = await restored.prompt('sessionA', 'continue A');
  assert.equal(next.nativeSessionFile, result.nativeSessionFile);
  assert.ok((await readFile(next.nativeSessionFile, 'utf8')).includes('marker session A'));
  await restored.shutdown();
});

test('restored native session binding survives relocation and repeated reopen without replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-restore-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'destination');
  const sourceCwd = join(root, 'source-cwd'), destinationCwd = join(root, 'destination-cwd');
  await Promise.all([mkdir(sourceCwd), mkdir(destinationCwd)]);
  const original = createPiAdapter({ sdk, modelRuntime: runtime(), model, root: source, cwd: sourceCwd });
  const first = await original.prompt('logicalSession', 'source marker that must survive relocation');
  const sourceFile = first.nativeSessionFile;
  const basename = sourceFile.slice(sourceFile.lastIndexOf('/') + 1);
  await original.shutdown();
  const targetDir = join(destination, 'sessions', 'logicalSession');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const targetFile = join(targetDir, basename);
  await copyFile(sourceFile, targetFile); // synthetic test-owned copy; source remains untouched
  await chmod(targetFile, 0o600);

  const defaultObserved = observeRuntime({ toolName: 'missing_tool' });
  const defaultAdapter = createPiAdapter({ sdk, modelRuntime: defaultObserved.modelRuntime, model, root: destination, cwd: destinationCwd });
  const copiedBytes = await readFile(targetFile);
  try {
    const defaultResult = await defaultAdapter.prompt('logicalSession', 'default relocation probe');
    assert.notEqual(defaultResult.nativeSessionFile, targetFile);
    assert.equal(modelUserText(defaultObserved.contexts).includes('source marker that must survive relocation'), false);
    assert.equal((await readFile(targetFile)).equals(copiedBytes), true);
  } finally {
    await defaultAdapter.shutdown();
  }

  const observed = observeRuntime({ toolName: 'missing_tool' });
  const binding = { logicalSession: basename };
  const restored = createPiAdapter({ sdk, modelRuntime: observed.modelRuntime, model, root: destination, cwd: destinationCwd, restoredSessionFiles: binding });
  binding.logicalSession = 'mutated-after-construction';
  const before = await readFile(targetFile, 'utf8');
  assert.match(before, /source marker that must survive relocation/);
  const resumed = await restored.prompt('logicalSession', 'relocated continuation marker');
  assert.equal(resumed.nativeSessionFile, targetFile);
  assert.ok(observed.contexts.some(context => JSON.stringify(context.messages).includes('source marker that must survive relocation')));
  const afterOne = await readFile(targetFile, 'utf8');
  assert.ok(afterOne.includes('relocated continuation marker'));
  await restored.shutdown();

  const again = createPiAdapter({ sdk, modelRuntime: runtime(), model, root: destination, cwd: destinationCwd, restoredSessionFiles: { logicalSession: basename } });
  const resumedAgain = await again.prompt('logicalSession', 'second continuation marker');
  assert.equal(resumedAgain.nativeSessionFile, targetFile);
  assert.ok((await readFile(targetFile, 'utf8')).includes('second continuation marker'));
  await again.shutdown();
});

test('restored session bindings reject invalid mappings and unsafe files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-restore-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'cwd'); await mkdir(cwd);
  const state = join(root, 'state');
  const make = options => createPiAdapter({ sdk, modelRuntime: runtime(), model, root: state, cwd, ...options });
  for (const bad of [[], Object.create({ inherited: '2026-01-01T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl' }),
    Object.defineProperty({}, 'sessionA', { enumerable: true, get() { throw new Error('getter invoked'); } }),
    { sessionA: '../escape.jsonl' }, { constructor: '2026-01-01T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl' }]) {
    assert.throws(() => make({ restoredSessionFiles: bad }), /restoredSessionFiles/);
  }
  const basename = `2026-01-01T00-00-00-000Z_${randomUUID()}.jsonl`;
  const adapter = make({ restoredSessionFiles: { sessionA: basename } });
  await assert.rejects(adapter.prompt('sessionA', 'must not create bound file'), /RESTORED_SESSION_MISSING/);
  assert.deepEqual(await readdir(state).catch(() => []), [], 'missing binding must not create session paths');
  await adapter.shutdown();

  const sessionDir = join(state, 'sessions', 'sessionA');
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const file = join(sessionDir, basename);
  await writeFile(file, '{}\n', { mode: 0o600 });
  const badContents = make({ restoredSessionFiles: { sessionA: basename } });
  await assert.rejects(badContents.prompt('sessionA', 'malformed history'), /SESSION|session|header|identity/i);
  await badContents.shutdown();
  await rm(file);
  await symlink(join(root, 'missing-target'), file);
  const linked = make({ restoredSessionFiles: { sessionA: basename } });
  await assert.rejects(linked.prompt('sessionA', 'symlink history'), /RESTORED_SESSION_INVALID/);
  await linked.shutdown();
  await rm(file);
  await writeFile(file, '{}\n', { mode: 0o600 });
  await chmod(file, 0o644);
  const publicFile = make({ restoredSessionFiles: { sessionA: basename } });
  await assert.rejects(publicFile.prompt('sessionA', 'public file'), /RESTORED_SESSION_INVALID/);
  await publicFile.shutdown();
  await chmod(file, 0o600);
  const extraLink = join(root, 'linked-history');
  await link(file, extraLink);
  const hardlinked = make({ restoredSessionFiles: { sessionA: basename } });
  await assert.rejects(hardlinked.prompt('sessionA', 'hardlinked file'), /RESTORED_SESSION_INVALID/);
  await hardlinked.shutdown();
  await rm(extraLink);
  await chmod(sessionDir, 0o755);
  const unsafeParent = make({ restoredSessionFiles: { sessionA: basename } });
  await assert.rejects(unsafeParent.prompt('sessionA', 'unsafe parent'), /RESTORED_SESSION_INVALID/);
  await unsafeParent.shutdown();
});

test('trusted resource-loader factory exposes only an explicit inert SDK skill to model context', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-adapter-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  const selectedDir = join(root, 'trusted', 'selected-inert');
  const projectDecoyDir = join(cwd, '.pi', 'skills', 'project-decoy');
  const agentDir = join(stateRoot, 'agent');
  const globalDecoyDir = join(agentDir, 'skills', 'global-decoy');
  await Promise.all([selectedDir, projectDecoyDir, globalDecoyDir].map(dir => mkdir(dir, { recursive: true })));
  await Promise.all([
    writeFile(join(selectedDir, 'SKILL.md'), '---\nname: selected-inert\ndescription: SELECTED_RESOURCE_DESCRIPTION_MARKER\n---\nINERT_SELECTED_SKILL_BODY_MARKER\n'),
    writeFile(join(projectDecoyDir, 'SKILL.md'), '---\nname: project-decoy\ndescription: PROJECT_DECOY_MARKER\n---\nUnselected.\n'),
    writeFile(join(globalDecoyDir, 'SKILL.md'), '---\nname: global-decoy\ndescription: GLOBAL_DECOY_MARKER\n---\nUnselected.\n'),
  ]);
  const observed = observeRuntime();
  let effects = 0, createdLoader;
  const tool = echoTool(() => effects++);
  const toolDefinitions = [inertReadTool(), tool];
  const adapter = createPiAdapter({
    sdk, modelRuntime: observed.modelRuntime, model, root: stateRoot, cwd, toolDefinitions,
    resourceLoaderFactory: async args => {
      assert.deepEqual(Object.keys(args).sort(), ['agentDir', 'cwd', 'sdk', 'sessionId', 'settingsManager', 'toolDefinitions']);
      assert.strictEqual(args.sdk, sdk);
      assert.equal(args.cwd, cwd);
      assert.equal(args.agentDir, agentDir);
      assert.deepEqual(args.settingsManager.getSkillPaths(), []);
      assert.deepEqual(args.settingsManager.getExtensionPaths(), []);
      assert.deepEqual(args.settingsManager.getPackages(), []);
      assert.deepEqual(args.toolDefinitions.map(item => item.name), ['read', 'fixture_echo']);
      assert.equal(typeof sdk.loadSkills, 'function');
      const explicit = sdk.loadSkills({ cwd, agentDir, skillPaths: [selectedDir], includeDefaults: false });
      assert.deepEqual(explicit.diagnostics, []);
      assert.deepEqual(explicit.skills.map(skill => skill.name), ['selected-inert']);
      createdLoader = isolatedLoader({
        ...args,
        skillsOverride: base => ({ skills: explicit.skills, diagnostics: [...base.diagnostics, ...explicit.diagnostics] }),
      });
      return createdLoader;
    },
  });
  const result = await adapter.prompt('selectedSession', '/skill:selected-inert');
  assert.equal(result.text, 'fixture complete');
  assert.equal(effects, 1);
  assert.deepEqual(createdLoader.getSkills().skills.map(skill => skill.name), ['selected-inert']);
  assert.equal(createdLoader.getSkills().skills[0].filePath, join(selectedDir, 'SKILL.md'));
  const systemMessages = observed.contexts.flatMap(context => context.messages ?? []).filter(message => message.role === 'system');
  assert.ok(systemMessages.some(message => message.sections && Object.keys(message.sections).length > 0));
  const sections = systemPromptSections(observed.contexts);
  assert.match(sections, /selected-inert/, `system sections: ${sections}`);
  assert.match(sections, /SELECTED_RESOURCE_DESCRIPTION_MARKER/, `system sections: ${sections}`);
  assert.doesNotMatch(sections, /project-decoy|global-decoy|DECOY_MARKER/);
  const userContext = modelUserText(observed.contexts);
  assert.match(userContext, /INERT_SELECTED_SKILL_BODY_MARKER/);
  assert.doesNotMatch(userContext, /PROJECT_DECOY_MARKER|GLOBAL_DECOY_MARKER/);
  await adapter.shutdown();
});

test('MCP selectors require an explicit loader and exact own-data selectors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-adapter-mcp-selector-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const toolName = 'mcp__fixture__echo';
  const options = { sdk, modelRuntime: runtime({ toolName }), model, root: join(root, 'state'), cwd };
  const selector = { name: toolName };
  assert.throws(() => createPiAdapter({ ...options, toolDefinitions: [selector] }), /MCP tool selector/);

  let captured, executions = 0;
  const adapter = createPiAdapter({ ...options, toolDefinitions: [selector], resourceLoaderFactory: async args => {
    captured = args.toolDefinitions;
    return new sdk.DefaultResourceLoader({ cwd, agentDir: args.agentDir, settingsManager: args.settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => pi.registerTool({ name: toolName, label: 'Fixture MCP selector', description: 'Synthetic only', parameters: Type.Object({ text: Type.String() }), execute: async () => { executions++; return { content: [{ type: 'text', text: 'synthetic MCP result' }] }; } })],
    });
  } });
  try {
    const result = await adapter.prompt('selector-session', 'synthetic selector');
    assert.equal(result.text, 'fixture complete');
    assert.equal(executions, 1);
    assert.deepEqual(captured, [{ name: toolName }]);
  } finally { await adapter.shutdown(); }

  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'name', { enumerable: true, get() { getterCalls++; return toolName; } });
  const invalid = [
    accessor,
    { name: 'fixture_echo' },
    { name: toolName, extra: true },
    Object.assign(Object.create({ inherited: true }), { name: toolName }),
  ];
  for (const value of invalid) assert.throws(() => createPiAdapter({ ...options, toolDefinitions: [value], resourceLoaderFactory: async () => ({}) }));
  assert.equal(getterCalls, 0);
  assert.doesNotThrow(() => createPiAdapter({ ...options, toolDefinitions: [{ name: toolName, execute() {} }] }), 'executable definitions remain valid; they are not name-only selectors');
  assert.throws(() => createPiAdapter({ ...options, toolDefinitions: [selector, { name: toolName, execute() {} }], resourceLoaderFactory: async () => ({}) }), /duplicate/);
  const sparse = []; sparse.length = 1;
  assert.throws(() => createPiAdapter({ ...options, toolDefinitions: sparse, resourceLoaderFactory: async () => ({}) }), /dense/);
  const extraArrayKey = [selector]; extraArrayKey.extra = true;
  assert.throws(() => createPiAdapter({ ...options, toolDefinitions: extraArrayKey, resourceLoaderFactory: async () => ({}) }), /dense/);
});

test('resource-loader factory and reload failures are not cached; retry and shutdown work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-adapter-loader-failures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const stateRoot = join(root, 'state');
  const tool = echoTool();
  let factoryCalls = 0, reloadCalls = 0;
  assert.throws(() => createPiAdapter({ sdk, modelRuntime: runtime(), model, root: stateRoot, cwd, resourceLoaderFactory: {} }), /trusted function/);
  const adapter = createPiAdapter({
    sdk, modelRuntime: runtime(), model, root: stateRoot, cwd, toolDefinitions: [tool],
    resourceLoaderFactory: async args => {
      factoryCalls++;
      if (factoryCalls === 1) throw new Error('RESOURCE_FACTORY_FAILED');
      if (factoryCalls === 2) return {};
      const loader = isolatedLoader(args);
      const reload = loader.reload.bind(loader);
      loader.reload = async (...reloadArgs) => {
        reloadCalls++;
        if (factoryCalls === 3) throw new Error('RESOURCE_RELOAD_FAILED');
        return reload(...reloadArgs);
      };
      return loader;
    },
  });
  await assert.rejects(adapter.prompt('retrySession', 'factory fail'), /RESOURCE_FACTORY_FAILED/);
  await assert.rejects(adapter.prompt('retrySession', 'invalid loader'), /SDK-compatible ResourceLoader/);
  await assert.rejects(adapter.prompt('retrySession', 'reload fail'), /RESOURCE_RELOAD_FAILED/);
  assert.deepEqual(await readdir(join(stateRoot, 'sessions', 'retrySession')), [], 'failed construction must not persist a session');
  const result = await adapter.prompt('retrySession', 'successful retry');
  assert.equal(result.text, 'fixture complete');
  assert.equal(factoryCalls, 4);
  assert.equal(reloadCalls, 2);
  await adapter.shutdown();
  await adapter.shutdown();
  await assert.rejects(adapter.prompt('retrySession', 'after close'), /HOST_CLOSED/);
});

test('adapter reports actual SDK provider errors and cancellation, without live model/auth', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-adapter-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const failed = createPiAdapter({ sdk, modelRuntime: runtime({ fail: true }), model, root: join(root, 'failed'), cwd });
  await assert.rejects(failed.prompt('s', 'fail'), /PROVIDER_FAILED/);
  await failed.shutdown();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const waiting = createPiAdapter({ sdk, modelRuntime: runtime({ waitForAbort: true, onStart: started }), model, root: join(root, 'cancel'), cwd });
  const pending = waiting.prompt('s', 'wait');
  const cancelled = assert.rejects(pending, /CANCELLED/);
  await ready;
  await assert.rejects(waiting.prompt('s', 'competing writer'), /SESSION_BUSY/);
  await waiting.cancel('s');
  await cancelled;
  await waiting.shutdown();
  const startup = createPiAdapter({ sdk, modelRuntime: runtime({ waitForAbort: true }), model, root: join(root, 'startup'), cwd });
  const beforeStart = startup.prompt('s', 'cancel before creation finishes');
  const earlyCancelled = assert.rejects(beforeStart, /CANCELLED/);
  await startup.cancel('s');
  await earlyCancelled;
  await startup.shutdown();
});
