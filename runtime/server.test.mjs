import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, open, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { makeRunner, startDevelopmentServer } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ENTRY = join(REPO, 'runtime/server.mjs');
const CANVAS = 'fixture';

test('runner keeps both canonical Pi success shapes text-only and preserves success after cancel request', async () => {
  const run = makeRunner(() => ({ prompt: async () => ({ text: 'plain' }), cancel: async () => true }));
  const plain = await run({ commandId: 'command-a', card: { sessionId: 'session-a' }, input: { text: 'prompt' }, signal: new AbortController().signal });
  if (Object.keys(plain).length !== 1 || plain.text !== 'plain') throw new Error('RUNNER_TEXT_PROJECTION_FAILED');

  const controller = new AbortController();
  let resolvePrompt;
  let cancelCalls = 0;
  const pendingPrompt = new Promise(resolvePromptResult => { resolvePrompt = resolvePromptResult; });
  const withNativePath = makeRunner(() => ({
    prompt: () => pendingPrompt,
    cancel: async () => { cancelCalls++; return true; },
  }));
  const pending = withNativePath({ commandId: 'command-b', card: { sessionId: 'session-b' }, input: { text: 'prompt' }, signal: controller.signal });
  controller.abort();
  resolvePrompt({ text: 'completed answer', nativeSessionFile: '/private/native-session.json' });
  const completed = await pending;
  if (Object.keys(completed).length !== 1 || completed.text !== 'completed answer' || cancelCalls !== 1) {
    throw new Error('CANCELLED_PROMPT_RESULT_LOST_OR_PATH_EXPOSED');
  }
});

test('runner forwards the reserved model selection with the trusted turn identity', async () => {
  const calls = [];
  const selection = { provider: 'openai-codex', modelId: 'gpt-6-luna', reasoning: 'high' };
  const run = makeRunner(() => ({ prompt: async (...args) => { calls.push(args); return { text: 'ok' }; }, cancel: async () => true }));
  await run({ commandId: 'command-model', card: { sessionId: 'session-a' }, input: { text: 'prompt', model: selection }, signal: new AbortController().signal });
  assert.deepEqual(calls, [['session-a', 'prompt', { turnId: 'command-model', model: selection }]]);
});

test('runner binds raw Pi events to the active session command and ignores late events', async () => {
  const events = [];
  let run;
  run = makeRunner(() => ({
    prompt: async () => {
      run.onExecutionEvent({ sessionId: 'session-a', type: 'text_delta', text: 'live' });
      run.onExecutionEvent({ sessionId: 'session-a', type: 'tool_execution_start', toolCallId: 'call_parent|fc_child', toolName: 'delegate_task' });
      run.onExecutionEvent({ sessionId: 'session-a', type: 'tool_execution_end', toolCallId: 'call_parent|fc_child', toolName: 'delegate_task', isError: false });
      return { text: 'ok' };
    },
    cancel: async () => true,
  }));
  await run({ commandId: 'command-events', card: { sessionId: 'session-a' }, input: { text: 'prompt' },
    signal: new AbortController().signal, emit: event => events.push(event) });
  assert.deepEqual(events.map(event => [event.type, event.turnId, event.sessionId]), [
    ['text.delta', 'command-events', 'session-a'],
    ['tool.started', 'command-events', 'session-a'],
    ['tool.completed', 'command-events', 'session-a'],
  ]);
  assert.equal(events[1].itemId, 'command-events:tool:call_parent|fc_child');
  run.onExecutionEvent({ sessionId: 'session-a', type: 'text_delta', text: 'late' });
  assert.equal(events.length, 3);
});

test('runner projects provider usage into bounded turn metrics', async () => {
  const events = [];
  let run;
  run = makeRunner(() => ({
    prompt: async () => {
      run.onExecutionEvent({ sessionId: 'session-a', type: 'turn_usage', usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 0, totalTokens: 160, durationMs: 2000 } });
      return { text: 'ok' };
    },
    cancel: async () => true,
  }));
  await run({ commandId: 'command-metrics', card: { sessionId: 'session-a' }, input: { text: 'prompt' }, signal: new AbortController().signal, emit: event => events.push(event) });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn.metrics');
  assert.deepEqual(events[0].payload, { input: 100, output: 40, cacheRead: 20, cacheWrite: 0, totalTokens: 160, durationMs: 2000 });
});

test('runner forwards trusted command identity, ignores model-supplied turnId and rejects invalid identity before dispatch', async () => {
  const calls = [];
  const run = makeRunner(() => ({
    async prompt(...args) { calls.push(args); return { text: 'ok' }; },
    async cancel() { return true; },
  }));
  const input = { card: { sessionId: 'session-a' }, input: { text: 'prompt', turnId: 'model-forged' }, signal: new AbortController().signal };
  await run({ ...input, commandId: 'trusted.command:1' });
  assert.deepEqual(calls, [['session-a', 'prompt', { turnId: 'trusted.command:1' }]]);
  for (const commandId of [undefined, null, '', 'bad/id', 'x'.repeat(129)]) {
    await assert.rejects(run({ ...input, commandId }), error => error.code === 'INVALID_COMMAND_ID' && error.safeNoSideEffect === true);
  }
  assert.equal(calls.length, 1);
});

function boundedExit(proc, timeoutMs = 8_000) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('PROCESS_STOP_TIMEOUT')), timeoutMs);
    proc.exitPromise.then(value => { clearTimeout(timer); resolveExit(value); }, error => { clearTimeout(timer); rejectExit(error); });
  });
}

function startProcess(args, stdio = ['ignore', 'pipe', 'pipe']) {
  const child = spawn(process.execPath, [ENTRY, ...args], { cwd: REPO, stdio });
  const messages = [];
  const waiters = [];
  let partial = '';
  let malformed = false;
  let exit;
  const exitPromise = new Promise(resolveExit => child.once('exit', (code, signal) => {
    exit = { code, signal };
    resolveExit(exit);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('PROCESS_EXITED_EARLY'));
    }
  }));
  child.on('error', () => { malformed = true; });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', chunk => {
    partial += chunk;
    let at;
    while ((at = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, at);
      partial = partial.slice(at + 1);
      try { messages.push(JSON.parse(line)); } catch { malformed = true; }
      for (const waiter of [...waiters]) {
        const found = messages.find(waiter.predicate);
        if (!found) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(found);
      }
    }
  });
  child.stderr?.on('data', () => {});
  return {
    child, messages, exitPromise,
    async waitFor(predicate) {
      const found = messages.find(predicate);
      if (found) return found;
      if (exit) throw new Error('PROCESS_EXITED_EARLY');
      return new Promise((resolveWait, rejectWait) => {
        const waiter = { predicate, resolve: resolveWait, reject: rejectWait, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectWait(new Error('PROCESS_OUTPUT_TIMEOUT'));
        }, 8_000);
        waiters.push(waiter);
      });
    },
    get malformed() { return malformed; },
    async stop() {
      if (!exit) child.kill('SIGTERM');
      return boundedExit({ exitPromise }, 10_000);
    },
  };
}

async function bootstrap(root) {
  const proc = startProcess(['--bootstrap', '--state-root', root]);
  const chunks = [];
  proc.child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const exit = await boundedExit(proc);
  const data = Buffer.concat(chunks);
  if (exit.code !== 0 || data.length !== 65 || data[64] !== 10 || !/^[a-f0-9]{64}$/.test(data.toString('ascii', 0, 64))) {
    throw new Error('BOOTSTRAP_PIPE_CONTRACT_FAILED');
  }
  return data.toString('ascii', 0, 64);
}

async function request(base, token, path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(3_000),
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('NON_JSON_HUB_RESPONSE'); }
  return { status: response.status, body: payload };
}

function checkReady(message, root) {
  if (!message || message.status !== 'READY' || !Number.isInteger(message.port) || message.port < 1 ||
      message.stateRoot !== root || message.live !== false || Object.keys(message).sort().join(',') !== 'live,port,stateRoot,status') {
    throw new Error('READINESS_METADATA_INVALID');
  }
}

test('live worker startup passes opaque auth path and retains ownership until child reap', { timeout: 20_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'aylachi-worker-reap-'));
  const appUrl = JSON.stringify(pathToFileURL(ENTRY).href);
  const childCode = `
    import { EventEmitter } from 'node:events';
    import { lstat } from 'node:fs/promises';
    import { join } from 'node:path';
    const { startDevelopmentServer } = await import(${appUrl});
    const stateRoot = process.env.TEST_STATE_ROOT;
    const sdkRoot = process.env.TEST_SDK_ROOT;
    const shouldReap = process.env.TEST_REAP === 'yes';
    let workerEnv, spawnCount = 0;
    const signals = [];
    const spawnChild = (_command, _args, options) => {
      spawnCount++;
      workerEnv = options.env;
      const child = new EventEmitter();
      child.pid = 777;
      child.exitCode = null;
      child.signalCode = null;
      child.connected = true;
      child.kill = signal => {
        signals.push(signal);
        if (shouldReap && signal === 'SIGTERM') setImmediate(() => {
          child.signalCode = 'SIGTERM';
          child.connected = false;
          child.emit('exit', null, 'SIGTERM');
        });
        return true;
      };
      setImmediate(() => child.emit('message', { type: 'startup_error', code: process.env.TEST_FAILURE_CODE || 'HOST_START_FAILED' }));
      return child;
    };
    let failure;
    try {
      await startDevelopmentServer({ stateRoot, port: 0, allowLive: true, sdkRoot,
        workerDependencies: { spawnChild, termGraceMs: 25, killGraceMs: 25 } });
    } catch (error) { failure = error; }
    let lockExists = false, rootExists = false;
    try { await lstat(join(stateRoot, '.server.lock')); lockExists = true; } catch {}
    try { await lstat(stateRoot); rootExists = true; } catch {}
    const scopedKeys = 'AYLACHI_DEV_AUTH_PATH,AYLACHI_DEV_DEADLINE_MS,AYLACHI_DEV_STATE_ROOT,AYLACHI_DEV_TOOLS,AYLACHI_SDK_ROOT,HOME,PATH,XDG_CONFIG_HOME,XDG_DATA_HOME';
    const result = {
      code: failure?.code || 'NO_ERROR', childStillOwned: failure?.childStillOwned === true,
      lockExists, rootExists, spawnCount, signals,
      authPathPassed: workerEnv?.AYLACHI_DEV_AUTH_PATH === '/home/ayla/.pi/agent/auth.json',
      privateHome: workerEnv?.HOME === join(stateRoot, 'pi'),
      onlyScopedEnv: Boolean(workerEnv && Object.keys(workerEnv).sort().join(',') === scopedKeys),
    };
    await new Promise(resolve => process.stdout.write(JSON.stringify(result) + '\\n', resolve));
    process.exit(0);
  `;
  const run = async (name, shouldReap, authPathOverride, failureCode = 'HOST_START_FAILED') => {
    const stateRoot = join(scratch, `state-${name}`);
    const sdkRoot = join(scratch, `sdk-${name}`);
    await mkdir(sdkRoot, { mode: 0o700 });
    const env = {
      PATH: '/usr/bin:/bin', HOME: join(scratch, `home-${name}`),
      TEST_STATE_ROOT: stateRoot, TEST_SDK_ROOT: sdkRoot, TEST_REAP: shouldReap ? 'yes' : 'no', TEST_FAILURE_CODE: failureCode,
    };
    if (authPathOverride) env.AYLACHI_DEV_AUTH_PATH = authPathOverride;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    const exitPromise = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    const exit = await boundedExit({ exitPromise }, 8_000);
    if (exit.code !== 0) throw new Error('FAKE_WORKER_SUBPROCESS_FAILED');
    return JSON.parse(output.trim());
  };
  try {
    const held = await run('held', false);
    assert.deepEqual(held, {
      code: 'LIVE_WORKER_REAP_UNRESOLVED', childStillOwned: true, lockExists: true, rootExists: true,
      spawnCount: 1, signals: ['SIGTERM', 'SIGKILL'], authPathPassed: true, privateHome: true, onlyScopedEnv: true,
    });
    const reaped = await run('reaped', true);
    assert.deepEqual(reaped, {
      code: 'LIVE_WORKER_START_FAILED', childStillOwned: false, lockExists: false, rootExists: true,
      spawnCount: 1, signals: ['SIGTERM'], authPathPassed: true, privateHome: true, onlyScopedEnv: true,
    });
    for (const code of ['SDK_VERSION_UNSUPPORTED', 'SDK_API_UNSUPPORTED', 'SDK_COHORT_UNSUPPORTED']) {
      const rejected = await run(code, true, undefined, code);
      assert.deepEqual(rejected, { ...reaped, code: `LIVE_${code}` });
    }
    const unknown = await run('unknown-code', true, undefined, '__proto__');
    assert.deepEqual(unknown, { ...reaped, code: 'LIVE_WORKER_PROTOCOL_FAILED' });
    const authSymlink = join(scratch, 'auth-symlink.json');
    await symlink('/home/ayla/.pi/agent/auth.json', authSymlink);
    const refused = await run('symlink', false, authSymlink);
    assert.deepEqual(refused, {
      code: 'AUTH_PATH_UNSAFE', childStillOwned: false, lockExists: false, rootExists: false,
      spawnCount: 0, signals: [], authPathPassed: false, privateHome: false, onlyScopedEnv: false,
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('actual model-OFF application persists cards, Wiki revisions and accepted Handoff across graceful restart', { timeout: 30_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'aylachi-dev-entry-'));
  const defaultRefusal = startProcess([]);
  assert.equal((await boundedExit(defaultRefusal)).code, 64);
  assert.equal(defaultRefusal.messages.length, 0);
  const stateRoot = join(scratch, 'state');
  const processes = [];
  let token;
  t.after(async () => {
    for (const proc of processes) {
      try { if (proc.child.exitCode === null && proc.child.signalCode === null) await proc.stop(); }
      catch { try { proc.child.kill('SIGKILL'); } catch {} }
    }
    await rm(scratch, { recursive: true, force: true });
  });

  const first = startProcess(['--state-root', stateRoot, '--port', '0']);
  processes.push(first);
  const ready1 = await first.waitFor(message => message.status === 'READY');
  checkReady(ready1, stateRoot);
  assert.equal(first.malformed, false);
  token = await bootstrap(stateRoot);
  assert.equal((await stat(stateRoot)).mode & 0o077, 0);
  assert.equal((await stat(join(stateRoot, '.bearer'))).mode & 0o777, 0o600);
  await assert.rejects(stat(join(stateRoot, 'delegation.sqlite')), error => error.code === 'ENOENT');
  if (first.messages.some(message => JSON.stringify(message).includes(token))) throw new Error('TOKEN_IN_READINESS_OUTPUT');

  const regularOutput = join(scratch, 'must-stay-empty');
  const file = await open(regularOutput, 'wx', 0o600);
  const refused = startProcess(['--bootstrap', '--state-root', stateRoot], ['ignore', file.fd, 'ignore']);
  const refusedExit = await boundedExit(refused);
  await file.close();
  assert.equal(refusedExit.code, 64);
  assert.equal((await stat(regularOutput)).size, 0);

  let base = `http://127.0.0.1:${ready1.port}`;
  const initial = await request(base, token, `/v1/cards?canvasId=${CANVAS}`);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.cards, []);
  const sourceCard = { requestId: 'create-source', id: 'source-card', canvasId: CANVAS, sessionId: 'source-session', title: 'Source', x: 0, y: 0 };
  assert.equal((await request(base, token, '/v1/cards', 'POST', sourceCard)).status, 201);
  const duplicateCard = await request(base, token, '/v1/cards', 'POST', sourceCard);
  assert.equal(duplicateCard.status, 200);
  assert.equal(duplicateCard.body.duplicate, true);
  assert.equal((await request(base, token, '/v1/snapshot?cardId=source-card')).body.eventSequence, 1);
  const targetCard = { requestId: 'create-target', id: 'target-card', canvasId: CANVAS, sessionId: 'target-session', title: 'Target', x: 1, y: 1 };
  assert.equal((await request(base, token, '/v1/cards', 'POST', targetCard)).status, 201);

  const createdNote = await request(base, token, '/v1/modules/wiki/notes', 'POST', { content: 'saved Wiki source\n' });
  assert.equal(createdNote.status, 201);
  const note = createdNote.body;
  const notePath = `/v1/modules/wiki/notes/${note.id}`;
  const revised = await request(base, token, notePath, 'POST', { expectedRevision: note.revision, content: 'new Wiki head\n' });
  assert.equal(revised.status, 200);

  const proposed = await request(base, token, '/v1/modules/handoff', 'POST', {
    requestId: 'propose-wiki-revision',
    source: { cardId: 'source-card', kind: 'wiki', id: note.id, revision: note.revision },
    targetCardId: 'target-card',
  });
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.record.snapshot.text, 'saved Wiki source\n');
  const recordId = proposed.body.record.id;
  const accepted = await request(base, token, `/v1/modules/handoff/${recordId}/accept`, 'POST', { requestId: 'accept-wiki-revision' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.record.state, 'accepted');

  const message = await request(base, token, '/v1/cards/source-card/messages', 'POST', { requestId: 'offline-chat', text: 'hello, no model' });
  assert.equal(message.status, 202);
  let command;
  for (let i = 0; i < 100; i++) {
    const found = await request(base, token, '/v1/commands/offline-chat');
    assert.equal(found.status, 200);
    command = found.body.command;
    if (command.state !== 'RUNNING') break;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.equal(command.state, 'COMPLETED');
  assert.deepEqual(command.result, { status: 'error', code: 'AGENT_NOT_CONFIGURED' });

  first.child.kill('SIGTERM');
  const stopped1 = await first.waitFor(message => message.status === 'STOPPED');
  assert.deepEqual(stopped1, { status: 'STOPPED', port: ready1.port, stateRoot, live: false });
  assert.equal((await boundedExit(first)).code, 0);

  const second = startProcess(['--state-root', stateRoot, '--port', '0']);
  processes.push(second);
  const ready2 = await second.waitFor(message => message.status === 'READY');
  checkReady(ready2, stateRoot);
  assert.equal(second.malformed, false);
  base = `http://127.0.0.1:${ready2.port}`;
  const cards = await request(base, token, `/v1/cards?canvasId=${CANVAS}`);
  assert.equal(cards.status, 200);
  assert.deepEqual(cards.body.cards.map(card => card.id).sort(), ['source-card', 'target-card']);
  const oldRevision = await request(base, token, `${notePath}?revision=${note.revision}`);
  assert.equal(oldRevision.status, 200);
  assert.equal(oldRevision.body.content, 'saved Wiki source\n');
  assert.equal((await request(base, token, notePath)).body.content, 'new Wiki head\n');
  const savedHandoff = await request(base, token, `/v1/modules/handoff/${recordId}`);
  assert.equal(savedHandoff.status, 200);
  assert.equal(savedHandoff.body.record.state, 'accepted');
  assert.equal(savedHandoff.body.record.snapshot.text, 'saved Wiki source\n');
  const savedCommand = await request(base, token, '/v1/commands/offline-chat');
  assert.equal(savedCommand.status, 200);
  assert.deepEqual(savedCommand.body.command.result, { status: 'error', code: 'AGENT_NOT_CONFIGURED' });
  if (second.messages.some(message => JSON.stringify(message).includes(token))) throw new Error('TOKEN_IN_READINESS_OUTPUT');

  second.child.kill('SIGTERM');
  const stopped2 = await second.waitFor(message => message.status === 'STOPPED');
  assert.deepEqual(stopped2, { status: 'STOPPED', port: ready2.port, stateRoot, live: false });
  assert.equal((await boundedExit(second)).code, 0);
  await assert.rejects(stat(join(stateRoot, 'delegation.sqlite')), error => error.code === 'ENOENT');
  t.diagnostic('synthetic state only; empty startup catalog; private bootstrap channel; regular-file refusal; persistent card/command/Wiki revision/Handoff; zero model calls; delegation DB absent when disabled');
});

test('delegation composition bootstraps fake worker, scopes parent session, deduplicates quota and closes cleanly', { timeout: 30_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'aylachi-dev-delegation-'));
  const stateRoot = join(scratch, 'state');
  const sdkRoot = join(scratch, 'sdk');
  const authPath = join(scratch, 'auth.json');
  await mkdir(sdkRoot, { mode: 0o700 });
  const authFile = await open(authPath, 'wx', 0o600);
  await authFile.close();
  const oldAuthPath = process.env.AYLACHI_DEV_AUTH_PATH;
  process.env.AYLACHI_DEV_AUTH_PATH = authPath;
  let seed;
  let app;
  let fake;
  try {
    seed = await startDevelopmentServer({ stateRoot, port: 0 });
    const bearer = (await readFile(join(stateRoot, '.bearer'), 'utf8')).trim();
    const seedBase = `http://127.0.0.1:${seed.address.port}`;
    assert.equal((await request(seedBase, bearer, '/v1/cards', 'POST', {
      requestId: 'seed-parent-card', id: 'parent-card', canvasId: CANVAS,
      sessionId: 'parent-session', title: 'Parent', x: 0, y: 0,
    })).status, 201);
    assert.deepEqual(await seed.shutdown(), { status: 'STOPPED' });
    seed = undefined;

    let spawnCount = 0;
    // Keep the fake worker entirely in-process; it never loads SDK/auth or calls a provider.
    const fakeSpawnChild = (_command, _args, options) => {
      spawnCount++;
      const child = new EventEmitter();
      child.pid = 7001;
      child.connected = true;
      child.exitCode = null;
      child.signalCode = null;
      const events = [];
      let parentPrompt, childPrompt;
      const reply = (message, result) => setImmediate(() => child.emit('message', { id: message.id, ok: true, result }));
      child.send = (message, callback) => {
        if (message?.type === 'delegation_bootstrap') {
          events.push('delegation_bootstrap');
          fake.frame = message;
          fake.env = options.env;
          fake.events = events;
          setImmediate(() => { callback?.(null); events.push('ready'); child.emit('message', { type: 'ready' }); });
        } else if (message?.verb === 'prompt') {
          if (message.sessionId === 'parent-session') { parentPrompt = message; fake.parentPrompt = message; }
          else { childPrompt = message; fake.childPrompt = message; }
          callback?.(null);
        } else if (message?.verb === 'cancel') {
          callback?.(null);
          reply(message, { cancelled: true });
        } else if (message?.verb === 'shutdown') {
          callback?.(null);
          reply(message, { shutdown: true });
          setTimeout(() => {
            child.signalCode = 'SIGTERM'; child.connected = false;
            child.emit('exit', null, 'SIGTERM');
          }, 5);
        } else callback?.(null);
        fake.releaseParent = () => { if (parentPrompt) { const current = parentPrompt; parentPrompt = undefined; reply(current, { text: 'parent done' }); } };
        fake.releaseChild = () => { if (childPrompt) { const current = childPrompt; childPrompt = undefined; reply(current, { text: 'child done' }); } };
        return true;
      };
      child.kill = signal => {
        setImmediate(() => { child.signalCode = signal; child.connected = false; child.emit('exit', null, signal); });
        return true;
      };
      fake.child = child;
      fake.env = options.env;
      setImmediate(() => child.emit('spawn'));
      return child;
    };
    fake = {};
    const badSpawner = () => { throw new Error('SHOULD_NOT_SPAWN'); };
    await assert.rejects(startDevelopmentServer({
      stateRoot, port: 0, allowLive: true, sdkRoot,
      delegation: { parentSessionIds: ['missing-session'] }, workerDependencies: { spawnChild: badSpawner },
    }), error => error.code === 'DELEGATION_PARENT_NOT_FOUND');
    assert.equal(spawnCount, 0);
    assert.equal((await stat(join(scratch, 'invalid-state', '.server.lock')).catch(() => null)), null);

    app = await startDevelopmentServer({
      stateRoot, port: 0, allowLive: true, sdkRoot,
      delegation: { parentSessionIds: ['parent-session'] },
      workerDependencies: { spawnChild: fakeSpawnChild, termGraceMs: 50, killGraceMs: 50 },
    });
    assert.equal(spawnCount, 1);
    const liveBearer = (await readFile(join(stateRoot, '.bearer'), 'utf8')).trim();
    const base = `http://127.0.0.1:${app.address.port}`;
    assert.deepEqual(fake.frame, {
      type: 'delegation_bootstrap',
      connection: { baseUrl: base, bearer: liveBearer },
      parentSessionIds: ['parent-session'], artifactEngine: true, themes: true,
    });
    assert.deepEqual(fake.events, ['delegation_bootstrap', 'ready']);
    assert.equal(fake.env.AYLACHI_DEV_DELEGATION, '1');
    assert.equal(fake.env.HOME, join(stateRoot, 'pi'));
    assert.equal(fake.env.AYLACHI_DEV_AUTH_PATH, authPath);
    assert.equal(Object.values(fake.env).includes(liveBearer), false);
    assert.equal((await stat(join(stateRoot, 'delegation.sqlite'))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(stateRoot, '.server-address'), 'utf8'), `${app.address.port}\n`);

    const parentRequest = await request(base, liveBearer, '/v1/cards/parent-card/messages', 'POST', {
      requestId: 'parent-command', text: 'parent prompt',
    });
    assert.equal(parentRequest.status, 202);
    for (let i = 0; i < 100 && !fake.parentPrompt; i++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    assert.ok(fake.parentPrompt, 'parent prompt must be active');
    assert.equal((await request(base, liveBearer, '/v1/modules/delegation?parentCommandId=parent-command&requestId=not-created')).status, 404);

    const taskBody = { parentCommandId: 'parent-command', requestId: 'delegate-one', text: 'child prompt' };
    const first = await request(base, liveBearer, '/v1/modules/delegation', 'POST', taskBody);
    assert.equal(first.status, 201);
    assert.equal(first.body.duplicate, false);
    assert.equal(first.body.record.parentCardId, 'parent-card');
    for (let i = 0; i < 100 && !fake.childPrompt; i++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    assert.ok(fake.childPrompt, 'delegated child prompt must be active');

    const retry = await request(base, liveBearer, '/v1/modules/delegation', 'POST', taskBody);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    const nested = await request(base, liveBearer, '/v1/modules/delegation', 'POST', {
      parentCommandId: first.body.record.childCommandId, requestId: 'nested-child', text: 'must not delegate',
    });
    assert.equal(nested.status, 404);
    const secondDistinct = await request(base, liveBearer, '/v1/modules/delegation', 'POST', {
      parentCommandId: 'parent-command', requestId: 'delegate-two', text: 'must not dispatch',
    });
    assert.equal(secondDistinct.status, 404);
    assert.equal(fake.childPrompt.sessionId === 'parent-session', false);

    fake.releaseChild();
    let childCommand;
    for (let i = 0; i < 100; i++) {
      childCommand = await request(base, liveBearer, `/v1/commands/${encodeURIComponent(first.body.record.childCommandId)}`);
      if (childCommand.body.command.state !== 'RUNNING') break;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    assert.equal(childCommand.body.command.state, 'COMPLETED');
    fake.releaseParent();
    let parentCommand;
    for (let i = 0; i < 100; i++) {
      parentCommand = await request(base, liveBearer, '/v1/commands/parent-command');
      if (parentCommand.body.command.state !== 'RUNNING') break;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    assert.equal(parentCommand.body.command.state, 'COMPLETED');
    const terminalRead = await request(base, liveBearer, '/v1/modules/delegation?parentCommandId=parent-command&requestId=delegate-one');
    assert.equal(terminalRead.status, 200);
    assert.equal(terminalRead.body.record.state, 'COMPLETED');
    const cards = await request(base, liveBearer, `/v1/cards?canvasId=${CANVAS}`);
    assert.deepEqual(cards.body.cards.map(card => card.id).sort(), [first.body.record.childCardId, 'parent-card'].sort());
    assert.deepEqual(await app.shutdown(), { status: 'STOPPED' });
    app = undefined;
    assert.equal((await stat(join(stateRoot, '.server.lock')).catch(() => null)), null);
    await assert.rejects(fetch(base), /fetch failed|ECONNREFUSED/);
    t.diagnostic('synthetic fake worker only; exact bootstrap precedes ready; validated existing parent session; one request per RUNNING parent; same-request retry; child session not whitelisted; terminal read; persistent delegation DB; clean shutdown');
  } finally {
    try { if (app) await app.shutdown(); } catch {}
    try { if (seed) await seed.shutdown(); } catch {}
    if (oldAuthPath === undefined) delete process.env.AYLACHI_DEV_AUTH_PATH;
    else process.env.AYLACHI_DEV_AUTH_PATH = oldAuthPath;
    await rm(scratch, { recursive: true, force: true });
  }
});
