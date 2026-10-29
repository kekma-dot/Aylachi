import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, realpath, readFile, lstat, rm, mkdir, writeFile, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDevelopmentServer } from './server.mjs';
import { loadPinnedMcpSupport } from './pi-worker.mjs';
import { openStore } from '../persistence/store.mjs';

const binding = { projectId: 'alpha', cardId: 'card-alpha', sessionId: 'session-alpha', bazaPrefix: '10 Проекты/Alpha/' };
const other = { projectId: 'beta', cardId: 'card-beta', sessionId: 'session-beta', bazaPrefix: '10 Проекты/Beta/' };
async function scratch(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-context-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function client(stateRoot, options = {}) {
  const app = await startDevelopmentServer({ stateRoot, port: 0, ...options });
  const token = (await readFile(join(stateRoot, '.bearer'), 'utf8')).trim();
  return { app, async request(path, body, authenticated = true) {
    const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  } };
}
const path = project => `/v1/modules/projects/${project}/context`;
const input = commandId => ({ commandId, query: 'synthetic context' });

// Uses the real assembled server/Hub/SQLite. The reader is synthetic; no vault or model calls.
test('assembled server binds context to current commands and trusted projects across restart', { timeout: 15000 }, async t => {
  const parent = await scratch(t), root = join(parent, 'state');
  let connection = await client(root), store;
  t.after(async () => { store?.close(); await connection.app.shutdown(); });
  for (const item of [binding, other]) {
    const created = await connection.request('/v1/cards', { requestId: `create-${item.cardId}`, id: item.cardId, canvasId: 'fixture', sessionId: item.sessionId, title: item.cardId, x: 0, y: 0 });
    assert.equal(created.status, 201);
  }
  assert.equal((await connection.request(path('alpha'), input('run-alpha'))).status, 404);
  await connection.app.shutdown();
  let calls = 0;
  const bindings = [{ ...binding }, { ...other }];
  connection = await client(root, { projectContext: { bindings, async readProjectContext(projectId, query, signal) {
    calls++; assert.equal(query, 'synthetic context'); assert.ok(signal instanceof AbortSignal);
    const prefix = projectId === 'alpha' ? binding.bazaPrefix : other.bazaPrefix;
    return { projectId, excerpts: [{ path: `${prefix}Context.md`, text: `synthetic ${projectId}` }] };
  } } });
  assert.equal(connection.app.modelStatus, 'disabled');
  bindings[0].projectId = 'beta'; bindings[0].bazaPrefix = other.bazaPrefix; bindings.length = 0;
  store = openStore(join(root, 'core.sqlite'));
  for (const item of [binding, other]) store.reserveCommand({ id: `run-${item.projectId}`, cardId: item.cardId, input: { text: 'synthetic current command' } });
  for (const item of [binding, other]) {
    const result = await connection.request(path(item.projectId), input(`run-${item.projectId}`));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { projectId: item.projectId, excerpts: [{ path: `${item.bazaPrefix}Context.md`, text: `synthetic ${item.projectId}` }] });
  }
  assert.equal(calls, 2);
  for (const [project, command] of [['alpha', 'run-beta'], ['beta', 'run-alpha'], ['gamma', 'run-alpha'], ['alpha', 'unknown']]) {
    assert.equal((await connection.request(path(project), input(command))).status, 404);
  }
  assert.equal((await connection.request(path('alpha'), input('run-alpha'), false)).status, 401);
  assert.equal((await connection.request(path('alpha'), { ...input('run-alpha'), sessionId: other.sessionId })).status, 400);
  store.completeCommand('run-alpha', { status: 'ok', value: { text: 'synthetic done' } });
  assert.equal((await connection.request(path('alpha'), input('run-alpha'))).status, 404);
  assert.equal(calls, 2);
  store.close(); store = undefined;
  await connection.app.shutdown();
  connection = await client(root);
  assert.equal((await connection.request(path('beta'), input('run-beta'))).status, 404, 'configuration is not persisted or implicitly re-enabled');
  assert.equal(calls, 2);
});

test('invalid context configuration fails before state creation without invoking accessors', async t => {
  const parent = await scratch(t);
  let accessed = false;
  const callback = async () => { throw Error('must not run'); };
  const invalid = [null, {}, { bindings: [], readProjectContext: callback },
    { bindings: [{ ...binding }, { ...binding }], readProjectContext: callback },
    { bindings: [binding, { ...other, sessionId: binding.sessionId }], readProjectContext: callback },
    { bindings: [binding, { ...other, projectId: binding.projectId }], readProjectContext: callback },
    { bindings: [{ ...binding, projectId: 'invalid:slug' }], readProjectContext: callback },
    { bindings: new Array(1), readProjectContext: callback },
    { bindings: [{ ...binding, bazaPrefix: '../outside/' }], readProjectContext: callback },
    { get bindings() { accessed = true; return [binding]; }, readProjectContext: callback }];
  for (const [index, projectContext] of invalid.entries()) {
    const root = join(parent, `invalid-${index}`);
    await assert.rejects(startDevelopmentServer({ stateRoot: root, port: 0, projectContext }), { code: 'PROJECT_CONTEXT_OPTIONS_INVALID' });
    await assert.rejects(lstat(root), { code: 'ENOENT' });
  }
  assert.equal(accessed, false);
});

test('configured card/session must already exist in the owned canvas; failed startup releases its lock', async t => {
  const parent = await scratch(t), root = join(parent, 'state');
  await assert.rejects(startDevelopmentServer({ stateRoot: root, port: 0, projectContext: {
    bindings: [binding], readProjectContext() { throw Error('must not run'); },
  } }), { code: 'STATE_ROOT_UNAVAILABLE' });
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  const first = await client(root);
  assert.equal((await first.request('/v1/cards', { requestId: 'create-alpha', id: binding.cardId, canvasId: 'fixture', sessionId: binding.sessionId, title: 'alpha', x: 0, y: 0 })).status, 201);
  await first.app.shutdown();
  for (const item of [{ ...binding, cardId: 'missing' }, { ...binding, sessionId: 'wrong-session' }]) {
    await assert.rejects(startDevelopmentServer({ stateRoot: root, port: 0, projectContext: { bindings: [item], readProjectContext() { throw Error('must not run'); } } }), { code: 'PROJECT_CONTEXT_CARD_NOT_FOUND' });
    await assert.rejects(lstat(join(root, '.server.lock')), { code: 'ENOENT' });
  }
  const reopened = await client(root);
  assert.equal(reopened.app.modelStatus, 'disabled');
  await reopened.app.shutdown();
});

// Actual production runWorker entry + pinned SDK, but replace ONLY model transport.
// No credential content is read and no real provider endpoint is invoked.
const actualWorkerModes = ['combined', 'mcp-only', 'skills-only'];
if (process.platform === 'linux' && process.env.AYLACHI_TEST_BWRAP === '1') actualWorkerModes.push('skills-bwrap', 'skills-isolated', 'skills-isolated-tmp');
for (const mode of actualWorkerModes) test(`assembled actual worker supports ${mode} with selected native skills`, { timeout: 20000 }, async t => {
  const isolationConfigured = mode === 'skills-isolated' || mode === 'skills-isolated-tmp';
  const mcpOnly = mode !== 'combined', sandboxOnly = mode === 'skills-bwrap' || isolationConfigured, skillsOnly = mode === 'skills-only' || sandboxOnly;
  const parent = sandboxOnly
    ? await mkdtemp(join(await realpath(mode === 'skills-isolated-tmp' ? tmpdir() : '/var/tmp'), 'aylachi-context-app-'))
    : await scratch(t);
  const root = join(parent, 'state');
  const provisioned = isolationConfigured ? await client(root) : undefined;
  const fakeSdk = join(isolationConfigured ? join(root, 'pi') : parent, 'synthetic-sdk');
  let outsideCanaryRoot, outsideCanary;
  if (sandboxOnly) {
    outsideCanaryRoot = await mkdtemp(join(dirname(parent), 'aylachi-context-outside-'));
    outsideCanary = join(outsideCanaryRoot, 'canary.txt');
    await writeFile(outsideCanary, 'parent-owned-canary', { mode: 0o600 });
  }
  const sdkRoot = process.env.AYLACHI_SDK_ROOT;
  assert.ok(sdkRoot, 'run via npm test or provide the pinned SDK root');
  const sdkUrl = pathToFileURL(join(sdkRoot, 'dist/index.js')).href;
  const eventUrl = pathToFileURL(join(resolve(sdkRoot, '../..'), '@earendil-works/pi-ai/dist/utils/event-stream.js')).href;
  await mkdir(join(fakeSdk, 'dist'), { recursive: true, mode: 0o700 });
  const selectedManifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
  await writeFile(join(fakeSdk, 'package.json'), JSON.stringify({ name: selectedManifest.name, version: selectedManifest.version, type: 'module', dependencies: { typebox: selectedManifest.dependencies.typebox } }));
  await symlink(resolve(sdkRoot, '../..'), join(fakeSdk, 'node_modules'), 'dir');
  const fakeAuth = join(isolationConfigured ? join(root, 'pi') : parent, 'synthetic-auth-not-a-user-credential');
  await writeFile(fakeAuth, '{}', { mode: 0o600 });
  const namespaceIds = sandboxOnly ? Object.fromEntries(await Promise.all(['mnt', 'net', 'pid'].map(async name => [name, await readlink(`/proc/self/ns/${name}`)]))) : null;
  await writeFile(join(fakeSdk, 'dist/index.js'), `
    import { readFileSync, readlinkSync, writeFileSync } from 'node:fs';
    export * from ${JSON.stringify(sdkUrl)};
    import { createAssistantMessageEventStream } from ${JSON.stringify(eventUrl)};
    const model = {id:'gpt-6-luna',provider:'openai-codex',api:'openai-codex-responses',name:'Synthetic context transport',reasoning:true,input:['text'],contextWindow:4096,maxTokens:512,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0}};
    export const ModelRuntime = { create(options) {
      if(options.authPath!==${JSON.stringify(fakeAuth)} || options.allowModelNetwork!==false) throw Error('unsafe fixture configuration');
      if(${JSON.stringify(sandboxOnly)}) {
        const canary=${JSON.stringify(outsideCanary)};
        const parentNamespaces=${JSON.stringify(namespaceIds)};
        for(const name of ['mnt','net','pid']) if(readlinkSync('/proc/self/ns/'+name)===parentNamespaces[name]) throw Error('namespace not isolated: '+name);
        try { readFileSync(canary); throw Error('outside canary visible'); } catch(error) { if(error.message==='outside canary visible' || error.code!=='ENOENT') throw error; }
        try { writeFileSync(canary,'sandbox-write'); throw Error('outside canary writable'); } catch(error) { if(error.message==='outside canary writable' || error.code!=='ENOENT') throw error; }
        if(process.env.HOME!==${JSON.stringify(join(root, 'pi'))} || process.env.NODE_OPTIONS!==undefined || process.env.AYLACHI_TEST_HOST_ENV_CANARY!==undefined) throw Error('sandbox environment leaked');
      }
      return { refresh:async()=>({}),getPhysicalModel:()=>model,getModel:()=>model,getAvailable:async()=>[model],hasConfiguredAuth:()=>true,isUsingOAuth:()=>true,
        streamSimple(_model,context) {
          const stream=createAssistantMessageEventStream();
          const advertisedTools=context.messages.flatMap(message=>message.role==='system'?(message.toolsAdded??[]):[]);
          if(${JSON.stringify(sandboxOnly)} && advertisedTools.length!==0) throw Error('skills-only sandbox advertised tools');
          const tools=advertisedTools.map(tool=>tool.name);
          const expectsDelegation=JSON.stringify(context.messages.filter(message=>message.role==='user')).includes('EXPECT_DELEGATION');
          if(tools.includes('delegate_task')!==expectsDelegation) throw Error('combined capability advertisement mismatch');
          const expectsNative=JSON.stringify(context.messages.filter(message=>message.role==='user')).includes('EXPECT_NATIVE');
          if(tools.includes('mcp__echo__echo')!==(expectsNative&&!${JSON.stringify(skillsOnly)})) throw Error('native capability advertisement mismatch');
          const users=JSON.stringify(context.messages.filter(message=>message.role==='user'));
          const nativeCall=users.includes('MCP_ECHO')||users.includes('MCP_FORBIDDEN');
          const lastUser=[...context.messages].reverse().find(message=>message.role==='user');
          const lastUserText=typeof lastUser?.content==='string'?lastUser.content:(lastUser?.content??[]).map(part=>part.text??'').join('');
          const isSkill=lastUserText.includes('SKILL_ARGS');
          if(globalThis.__AYLACHI_L06_SKILL_BODY_EXECUTED__!==undefined) throw Error('skill source executed');
          const last=context.messages.at(-1), use=!isSkill&&(nativeCall||tools.includes('project_context'))&&last?.role!=='toolResult';
          const toolName=nativeCall?(users.includes('MCP_FORBIDDEN')?'mcp__echo__forbidden':'mcp__echo__echo'):'project_context';
          const content=use?[{type:'toolCall',id:'context-read-1',name:toolName,arguments:nativeCall?{}:{query:'synthetic context'}}]:[{type:'text',text:isSkill?(lastUserText.includes('This Markdown body is inert test content.')?'SKILL_EXPANDED':'SKILL_UNEXPANDED'):last?.role==='toolResult'?last.content.map(part=>part.text??'').join(''):'NO_PROJECT_TOOL'}];
          const message={role:'assistant',content,stopReason:use?'toolUse':'stop',api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},timestamp:Date.now()};
          stream.push({type:'done',reason:message.stopReason,message});return stream;
        }
      };
    }};
  `);
  assert.equal(typeof (await loadPinnedMcpSupport(fakeSdk)).StreamableHttpTransport, 'function');
  let connection = provisioned ?? await client(root);
  const nativeCalls = [];
  const mcp = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/mcp');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      let body = '';
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 32768) throw Error('fixture request limit'); }
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'owned-fixture', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: ['echo', 'forbidden'].map(name => ({ name, inputSchema: { type: 'object' } })) };
      else if (message.method === 'tools/call') {
        nativeCalls.push(message.params.name);
        result = { content: [{ type: 'text', text: 'SYNTHETIC_MCP_ECHO' }] };
      } else throw Error('unexpected fixture method');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolvePromise => mcp.listen(0, '127.0.0.1', resolvePromise));
  const nativeUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;
  let sandboxChild, sandboxSpawnCount = 0;
  const oldCanaryEnv = process.env.AYLACHI_TEST_HOST_ENV_CANARY;
  t.after(async () => {
    try {
      const stopped = await connection.app.shutdown();
      if (isolationConfigured) {
        assert.equal(stopped.status, 'STOPPED', 'production isolation shutdown resolved');
        await assert.rejects(lstat(join(root, '.server.lock')), { code: 'ENOENT' });
      }
      if (sandboxOnly) {
        if (!isolationConfigured) {
          assert.equal(sandboxSpawnCount, 1, 'exactly one production worker spawn');
          assert.ok(sandboxChild && (sandboxChild.exitCode !== null || sandboxChild.signalCode !== null), 'sandbox worker reaped after app shutdown');
        }
        assert.equal(await readFile(outsideCanary, 'utf8'), 'parent-owned-canary', 'sandbox never modified the parent canary');
      }
    } finally {
      if (oldCanaryEnv === undefined) delete process.env.AYLACHI_TEST_HOST_ENV_CANARY; else process.env.AYLACHI_TEST_HOST_ENV_CANARY = oldCanaryEnv;
      mcp.closeIdleConnections(); await new Promise(resolvePromise => mcp.close(resolvePromise));
      if (sandboxOnly) {
        await rm(outsideCanaryRoot, { recursive: true, force: true });
        await rm(parent, { recursive: true, force: true });
      }
    }
  });
  for (const item of [binding, other, { cardId: 'unbound', sessionId: 'unbound-session' }]) {
    assert.equal((await connection.request('/v1/cards', { requestId: `create-${item.cardId}`, id: item.cardId, canvasId: 'fixture', sessionId: item.sessionId, title: item.cardId, x: 0, y: 0 })).status, 201);
  }
  await connection.app.shutdown();
  const oldAuthPath = process.env.AYLACHI_DEV_AUTH_PATH;
  let calls = 0;
  const maxSdkCalls = skillsOnly ? 4 : mcpOnly ? 8 : 11;
  const skillContent = await readFile(new URL('../compatibility/skills-sdk-fixture.md', import.meta.url), 'utf8');
  let workerDependencies;
  if (sandboxOnly && !isolationConfigured) {
    const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const sdkNodeModules = await realpath(join(repoRoot, 'node_modules'));
    assert.ok((await realpath(sdkRoot)).startsWith(`${sdkNodeModules}/`), 'pinned SDK must be inside the read-only repository node_modules');
    const nodeExecutable = await realpath(process.execPath);
    const nodeInstall = dirname(dirname(nodeExecutable));
    const roBinds = [['/usr', '/usr'], ['/lib', '/lib'], ['/lib64', '/lib64']];
    if (!nodeExecutable.startsWith('/usr/') && !nodeExecutable.startsWith('/lib/') && !nodeExecutable.startsWith('/lib64/') &&
        !nodeInstall.startsWith(`${repoRoot}/`)) roBinds.push([nodeInstall, nodeInstall]);
    roBinds.push([repoRoot, repoRoot]);
    const bwrap = '/usr/bin/bwrap';
    await lstat(bwrap);
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'pi-worker.mjs');
    workerDependencies = { termGraceMs: 100, killGraceMs: 100, spawnChild(command, args, options) {
      sandboxSpawnCount++;
      assert.equal(sandboxSpawnCount, 1, 'only one production worker spawn');
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [workerPath]);
      assert.equal(options.cwd, join(root, 'workspace'));
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      assert.equal(options.env.HOME, join(root, 'pi'));
      assert.equal(options.env.AYLACHI_DEV_STATE_ROOT, root);
      assert.equal(options.env.AYLACHI_SDK_ROOT, fakeSdk);
      assert.equal(options.env.AYLACHI_DEV_AUTH_PATH, fakeAuth);
      assert.equal(options.env.AYLACHI_DEV_MAX_SDK_CALLS, String(maxSdkCalls));
      assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
      assert.equal(Object.hasOwn(options.env, 'AYLACHI_TEST_HOST_ENV_CANARY'), false);
      const bwrapArgs = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
      for (const [source, destination] of roBinds) bwrapArgs.push('--ro-bind', source, destination);
      bwrapArgs.push('--ro-bind', parent, parent, '--bind', root, root, '--chdir', options.cwd, '--clearenv');
      for (const [key, value] of Object.entries(options.env)) bwrapArgs.push('--setenv', key, value);
      bwrapArgs.push('--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'NODE_CHANNEL_FD', '3',
        '--setenv', 'NODE_CHANNEL_SERIALIZATION_MODE', 'json', '--', command, ...args);
      return sandboxChild = spawn(bwrap, bwrapArgs, { cwd: '/', env: {}, stdio: options.stdio, windowsHide: true });
    } };
  }
  try {
    process.env.AYLACHI_DEV_AUTH_PATH = fakeAuth;
    if (sandboxOnly) process.env.AYLACHI_TEST_HOST_ENV_CANARY = 'not-for-worker';
    connection = await client(root, { allowLive: true, sdkRoot: fakeSdk, liveLimits: { maxSdkCalls, durationMs: 60000 }, ...(workerDependencies ? { workerDependencies } : {}), ...(isolationConfigured ? { workerIsolation: 'bubblewrap-offline' } : {}), nativeSkills: { bindings: [{ cardId: binding.cardId, sessionId: binding.sessionId, skills: [{ name: 'l06-skills-fixture', description: 'Synthetic skill fixture', content: skillContent }] }] }, nativeMcp: skillsOnly ? undefined : { bindings: [{ cardId: binding.cardId, sessionId: binding.sessionId, serverName: 'echo', url: nativeUrl, tools: ['echo'] }] }, delegation: mcpOnly ? undefined : { parentSessionIds: [binding.sessionId] }, projectContext: mcpOnly ? undefined : { bindings: [binding, other],
      async readProjectContext(projectId, query) {
        calls++; assert.equal(query, 'synthetic context');
        return { projectId, excerpts: [{ path: `${projectId === 'alpha' ? binding.bazaPrefix : other.bazaPrefix}Synthetic.md`, text: `SCOPED_${projectId}` }] };
      },
    } });
  } finally {
    if (oldAuthPath === undefined) delete process.env.AYLACHI_DEV_AUTH_PATH; else process.env.AYLACHI_DEV_AUTH_PATH = oldAuthPath;
  }
  async function message(cardId, commandId, text = 'Read this project context') {
    const markers = cardId === binding.cardId ? `${skillsOnly ? '' : 'EXPECT_NATIVE'} ${mcpOnly ? '' : 'EXPECT_DELEGATION'}` : '';
    const prompt = text.startsWith('/skill:') ? `${text} ${markers}` : `${markers} ${text}`;
    const sent = await connection.request(`/v1/cards/${cardId}/messages`, { requestId: commandId, text: prompt });
    assert.equal(sent.status, 202);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const report = await connection.request(`/v1/commands/${commandId}`);
      assert.equal(report.status, 200);
      if (report.body.command.state !== 'RUNNING') return report.body.command;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    assert.fail('synthetic worker command timeout');
  }
  for (const item of mcpOnly ? [] : [binding, other]) {
    const report = await message(item.cardId, `context-${item.projectId}`);
    assert.equal(report.state, 'COMPLETED');
    assert.equal(report.result.status, 'ok');
    const context = JSON.parse(report.result.text);
    assert.equal(context.projectId, item.projectId);
    assert.equal(context.excerpts[0].text, `SCOPED_${item.projectId}`);
  }
  const denied = await message('unbound', 'context-unbound');
  assert.equal(denied.result.text, 'NO_PROJECT_TOOL');
  if (mcpOnly) assert.equal((await message(other.cardId, 'native-peer')).result.text, 'NO_PROJECT_TOOL');
  assert.equal(calls, mcpOnly ? 0 : 2, 'unbound SDK sessions must have no project reader');
  if (!skillsOnly) {
    const nativeEcho = await message(binding.cardId, 'native-echo', 'MCP_ECHO');
    assert.equal(nativeEcho.state, 'COMPLETED');
    assert.match(nativeEcho.result.text, /SYNTHETIC_MCP_ECHO/);
    const nativeForbidden = await message(binding.cardId, 'native-forbidden', 'MCP_FORBIDDEN');
    assert.equal(nativeForbidden.state, 'COMPLETED');
    assert.doesNotMatch(nativeForbidden.result.text, /SYNTHETIC_MCP_ECHO/);
  }
  assert.equal((await message(binding.cardId, 'skill-selected', '/skill:l06-skills-fixture SKILL_ARGS')).result.text, 'SKILL_EXPANDED');
  assert.equal((await message('unbound', 'skill-unbound', '/skill:l06-skills-fixture SKILL_ARGS')).result.text, 'SKILL_UNEXPANDED');
  assert.deepEqual(nativeCalls, skillsOnly ? [] : ['echo'], 'skills do not grant or invoke additional native tools');
  const budget = JSON.parse(await readFile(join(root, 'live-budget.json'), 'utf8'));
  assert.equal(budget.sdkCallsStarted, maxSdkCalls, 'bound/native/denied/unbound turns consume only the expected synthetic calls');
  assert.equal(budget.maxSdkCalls, maxSdkCalls, 'configured cap reaches the production worker');
  assert.ok(budget.deadlineEpochMs <= Date.now() + 60000);
  const exhausted = await message('unbound', 'context-over-budget');
  assert.equal(exhausted.state, 'NEEDS_RECONCILIATION');
  assert.equal(exhausted.result.status, 'needs_reconciliation', 'do not mislabel an unknown post-prompt outcome as safe-to-retry');
  assert.equal(JSON.parse(await readFile(join(root, 'live-budget.json'), 'utf8')).sdkCallsStarted, maxSdkCalls, 'no stream may start beyond the configured cap');
});
