import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseArgs, startDevelopmentServer } from './server.mjs';

const ROOT = join(tmpdir(), 'aylachi-module-toggle-tests');
const ENTRY = fileURLToPath(new URL('./server.mjs', import.meta.url));

async function newRoot() {
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  return join(ROOT, `state-${randomUUID()}`);
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function start(stateRoot, options = {}) {
  const app = await startDevelopmentServer({ stateRoot, port: 0, ...options });
  try {
    const token = (await readFile(join(stateRoot, '.bearer'), 'utf8')).trim();
    const base = `http://127.0.0.1:${app.address.port}`;
    return {
      app,
      async request(path, { method = 'GET', body } = {}) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: response.status === 204 ? null : await response.json() };
      },
    };
  } catch (error) {
    await app.shutdown('TEST_CLEANUP').catch(() => {});
    throw error;
  }
}

async function stop(app) {
  const report = await app.shutdown('TEST_COMPLETE');
  assert.equal(report.status, 'STOPPED');
  assert.equal((await app.done).status, 'STOPPED');
}

async function createCard(client, id) {
  const response = await client.request('/v1/cards', {
    method: 'POST',
    body: { requestId: `create-${id}`, id, canvasId: 'fixture', sessionId: `session-${id}`, title: id, x: 0, y: 0 },
  });
  assert.equal(response.status, 201);
}

async function commandView(client, id) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await client.request(`/v1/commands/${encodeURIComponent(id)}`);
    if (response.status === 200 && response.body.command.state !== 'RUNNING') return response.body.command;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`command did not complete: ${id}`);
}

async function hashFile(path) {
  if (!await exists(path)) return null;
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function hashTree(path) {
  if (!await exists(path)) return null;
  const files = [];
  async function visit(dir, relative = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, rel);
      else {
        assert.ok(entry.isFile(), `unexpected non-file in module storage: ${full}`);
        files.push([rel, createHash('sha256').update(await readFile(full)).digest('hex')]);
      }
    }
  }
  await visit(path);
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

async function storageHashes(stateRoot) {
  return {
    wiki: await hashTree(join(stateRoot, 'wiki')),
    handoff: await hashFile(join(stateRoot, 'handoff.sqlite')),
  };
}

function launchCli(args) {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { child.stderrText += chunk; });
  return child;
}

function waitCliExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stdout: child.stdoutText, stderr: child.stderrText });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI_TIMEOUT')), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: child.stdoutText, stderr: child.stderrText });
    });
  });
}

async function cli(args) {
  return waitCliExit(launchCli(args));
}

async function cliReady(child) {
  const deadline = Date.now() + 5_000;
  while (!child.stdoutText.includes('\n') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(child.stdoutText.includes('\n'), `CLI did not become ready: ${child.stderrText}`);
  return JSON.parse(child.stdoutText.split('\n')[0]);
}

test('workspace capability snapshot reflects startup modules behind authentication', async t => {
  for (const disabledModules of [[], ['wiki'], ['handoff'], ['wiki', 'handoff']]) {
    await t.test(`disabled=${disabledModules.join(',') || 'none'}`, async () => {
      const stateRoot = await newRoot();
      const client = await start(stateRoot, { disabledModules });
      try {
        const path = '/v1/modules/workspace/capabilities';
        const snapshot = await client.request(path);
        assert.equal(snapshot.status, 200);
        assert.deepEqual(snapshot.body, { version: 1, modules: {
          wiki: !disabledModules.includes('wiki'), handoff: !disabledModules.includes('handoff'), artifactEngine: true, backends: true, pluginPlane: true, channels: true, memory: true, browser: true, themes: true,
        } });
        const denied = await fetch(`http://127.0.0.1:${client.app.address.port}${path}`);
        assert.equal(denied.status, 401);
        assert.deepEqual(await denied.json(), { error: 'unauthorized' });
        assert.equal((await client.request(`${path}?wiki=true`)).status, 400);
        assert.equal((await client.request(path, { method: 'POST', body: {} })).status, 404);
        if (disabledModules.includes('wiki')) {
          assert.equal(await exists(join(stateRoot, 'wiki')), false);
          assert.equal((await client.request('/v1/modules/wiki/notes')).status, 404);
        }
        if (disabledModules.includes('handoff')) {
          assert.equal(await exists(join(stateRoot, 'handoff.sqlite')), false);
          assert.equal((await client.request('/v1/modules/handoff/transfers')).status, 404);
        }
      } finally { await stop(client.app); }
    });
  }
});

test('default parser shape stays compatible; module flags are repeatable and bootstrap-incompatible', () => {
  assert.deepEqual(parseArgs(['--state-root', '/tmp/state']), {
    help: false, bootstrap: false, allowLive: false, stateRoot: '/tmp/state', sdkRoot: undefined,
    port: 46231, portSpecified: false,
  });
  assert.deepEqual(parseArgs(['--state-root', '/tmp/state', '--disable-module', 'wiki', '--disable-module', 'handoff']).disabledModules, ['wiki', 'handoff']);
  for (const args of [
    ['--state-root', '/tmp/state', '--disable-module', 'unknown'],
    ['--state-root', '/tmp/state', '--disable-module', 'wiki', '--disable-module', 'wiki'],
    ['--state-root', '/tmp/state', '--disable-module'],
    ['--bootstrap', '--state-root', '/tmp/state', '--disable-module', 'wiki'],
  ]) assert.throws(() => parseArgs(args), error => error.code === 'INVALID_ARGUMENTS');
});

test('constructor rejects malformed module lists before creating state', { timeout: 10_000 }, async () => {
  const invalid = [null, ['unknown'], ['wiki', 'wiki'], ['wiki', 'handoff', 'wiki'], new Array(1), Object.assign(['wiki'], { extra: true })];
  for (const disabledModules of invalid) {
    const stateRoot = await newRoot();
    await assert.rejects(startDevelopmentServer({ stateRoot, port: 0, disabledModules }), error => error.code === 'MODULE_OPTIONS_INVALID');
    assert.equal(await exists(stateRoot), false);
  }
});

test('CLI rejects invalid module flags and bootstrap combinations before state effects', { timeout: 15_000 }, async () => {
  const cases = [
    ['--disable-module', 'unknown'],
    ['--disable-module', 'wiki', '--disable-module', 'wiki'],
    ['--disable-module'],
    ['--bootstrap', '--disable-module', 'handoff'],
  ];
  for (const flags of cases) {
    const stateRoot = await newRoot();
    const result = await cli(['--state-root', stateRoot, ...flags]);
    assert.equal(result.code, 64);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /INVALID_ARGUMENTS/);
    assert.equal(await exists(stateRoot), false);
  }
});

test('CLI starts with repeatable disable flags and retains readiness output shape', { timeout: 15_000 }, async () => {
  const stateRoot = await newRoot();
  const child = launchCli(['--state-root', stateRoot, '--port', '0', '--disable-module', 'wiki', '--disable-module', 'handoff']);
  try {
    const ready = await cliReady(child);
    assert.deepEqual(Object.keys(ready).sort(), ['live', 'port', 'stateRoot', 'status']);
    assert.equal(ready.status, 'READY');
    assert.equal(ready.live, false);
    assert.equal(ready.stateRoot, stateRoot);
    assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    assert.equal(await exists(join(stateRoot, 'wiki')), false);
    assert.equal(await exists(join(stateRoot, 'handoff.sqlite')), false);
    child.kill('SIGTERM');
    const result = await waitCliExit(child);
    assert.equal(result.code, 0);
    const lines = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines[1], { status: 'STOPPED', port: ready.port, stateRoot, live: false });
    assert.equal(await exists(join(stateRoot, 'wiki')), false);
    assert.equal(await exists(join(stateRoot, 'handoff.sqlite')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try { await waitCliExit(child); }
      catch { child.kill('SIGKILL'); await waitCliExit(child, 2_000).catch(() => {}); }
    }
  }
});

test('defaults preserve Wiki/Handoff; disabling Wiki conceals retained sources without changing bytes', { timeout: 60_000 }, async () => {
  const stateRoot = await newRoot();
  const first = await start(stateRoot);
  try {
    assert.equal(first.app.modelStatus, 'disabled');
    assert.equal(await exists(join(stateRoot, 'wiki')), true);
    assert.equal(await exists(join(stateRoot, 'handoff.sqlite')), true);
    await createCard(first, 'source-card');
    await createCard(first, 'target-card');
    const noteResponse = await first.request('/v1/modules/wiki/notes', { method: 'POST', body: { content: 'Preserve this module-toggle snapshot.' } });
    assert.equal(noteResponse.status, 201);
    const note = noteResponse.body;
    const proposal = await first.request('/v1/modules/handoff', {
      method: 'POST',
      body: { requestId: 'toggle-propose', source: { cardId: 'source-card', kind: 'wiki', id: note.id, revision: note.revision }, targetCardId: 'target-card' },
    });
    assert.equal(proposal.status, 200);
    const accept = await first.request(`/v1/modules/handoff/${proposal.body.record.id}/accept`, {
      method: 'POST', body: { requestId: 'toggle-accept' },
    });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.record.state, 'accepted');
    assert.equal(accept.body.record.snapshot.text, 'Preserve this module-toggle snapshot.');
    await stop(first.app);

    const before = await storageHashes(stateRoot);
    assert.ok(before.wiki);
    assert.ok(before.handoff);
    const off = await start(stateRoot, { disabledModules: ['wiki'] });
    try {
      assert.equal((await off.request(`/v1/modules/wiki/notes/${note.id}`)).status, 404);
      const concealed = await off.request(`/v1/modules/handoff/${proposal.body.record.id}`);
      assert.equal(concealed.status, 404);
      assert.deepEqual(concealed.body, { error: 'not_found' });
      assert.deepEqual((await off.request('/v1/modules/handoff?targetCardId=target-card')).body, { items: [] });
      const acceptedAgain = await off.request(`/v1/modules/handoff/${proposal.body.record.id}/accept`, {
        method: 'POST', body: { requestId: 'toggle-accept-while-wiki-off' },
      });
      assert.equal(acceptedAgain.status, 404);
      assert.equal(await exists(join(stateRoot, 'wiki')), true);
      assert.equal(await exists(join(stateRoot, 'handoff.sqlite')), true);

      const message = await off.request('/v1/cards/source-card/messages', {
        method: 'POST', body: { requestId: 'chat-with-wiki-off', text: 'Core chat remains available.' },
      });
      assert.equal(message.status, 202);
      const command = await commandView(off, 'chat-with-wiki-off');
      assert.equal(command.state, 'COMPLETED');
      assert.deepEqual(command.result, { status: 'error', code: 'AGENT_NOT_CONFIGURED' });
      await stop(off.app);
    } finally { await off.app.shutdown('TEST_CLEANUP').catch(() => {}); }
    assert.deepEqual(await storageHashes(stateRoot), before);

    const bothOff = await start(stateRoot, { disabledModules: ['wiki', 'handoff'] });
    try {
      assert.equal((await bothOff.request(`/v1/modules/wiki/notes/${note.id}`)).status, 404);
      assert.equal((await bothOff.request(`/v1/modules/handoff/${proposal.body.record.id}`)).status, 404);
      assert.equal(await exists(join(stateRoot, 'wiki')), true);
      assert.equal(await exists(join(stateRoot, 'handoff.sqlite')), true);
      const message = await bothOff.request('/v1/cards/target-card/messages', {
        method: 'POST', body: { requestId: 'chat-with-both-off', text: 'Core chat remains available.' },
      });
      assert.equal(message.status, 202);
      assert.deepEqual((await commandView(bothOff, 'chat-with-both-off')).result, { status: 'error', code: 'AGENT_NOT_CONFIGURED' });
      assert.equal(await exists(join(stateRoot, 'wiki')), true);
      assert.equal(await exists(join(stateRoot, 'handoff.sqlite')), true);
      await stop(bothOff.app);
    } finally { await bothOff.app.shutdown('TEST_CLEANUP').catch(() => {}); }
    assert.deepEqual(await storageHashes(stateRoot), before);

    const restored = await start(stateRoot);
    try {
      const noteAgain = await restored.request(`/v1/modules/wiki/notes/${note.id}?revision=${note.revision}`);
      assert.equal(noteAgain.status, 200);
      assert.equal(noteAgain.body.revision, note.revision);
      assert.equal(noteAgain.body.content, 'Preserve this module-toggle snapshot.');
      const handoffAgain = await restored.request(`/v1/modules/handoff/${proposal.body.record.id}`);
      assert.equal(handoffAgain.status, 200);
      assert.equal(handoffAgain.body.record.state, 'accepted');
      assert.deepEqual(handoffAgain.body.record.source, proposal.body.record.source);
      assert.deepEqual(handoffAgain.body.record.snapshot, accept.body.record.snapshot);
      await stop(restored.app);
    } finally { await restored.app.shutdown('TEST_CLEANUP').catch(() => {}); }
  } finally { await first.app.shutdown('TEST_CLEANUP').catch(() => {}); }
});

test('each module can be disabled independently and both can be disabled without blocking core chat', { timeout: 30_000 }, async () => {
  const wikiOffRoot = await newRoot();
  const wikiOff = await start(wikiOffRoot, { disabledModules: ['wiki'] });
  try {
    assert.equal(await exists(join(wikiOffRoot, 'wiki')), false);
    assert.equal(await exists(join(wikiOffRoot, 'handoff.sqlite')), true);
    assert.equal((await wikiOff.request('/v1/modules/wiki/notes?query=x')).status, 404);
    await createCard(wikiOff, 'wiki-off-target');
    assert.deepEqual((await wikiOff.request('/v1/modules/handoff?targetCardId=wiki-off-target')).body, { items: [] });
    await stop(wikiOff.app);
  } finally { await wikiOff.app.shutdown('TEST_CLEANUP').catch(() => {}); }

  const handoffOffRoot = await newRoot();
  const handoffOff = await start(handoffOffRoot, { disabledModules: ['handoff'] });
  try {
    assert.equal(await exists(join(handoffOffRoot, 'wiki')), true);
    assert.equal(await exists(join(handoffOffRoot, 'handoff.sqlite')), false);
    assert.equal((await handoffOff.request('/v1/modules/handoff?targetCardId=unused')).status, 404);
    const note = await handoffOff.request('/v1/modules/wiki/notes', { method: 'POST', body: { content: 'Wiki stays enabled.' } });
    assert.equal(note.status, 201);
    await stop(handoffOff.app);
  } finally { await handoffOff.app.shutdown('TEST_CLEANUP').catch(() => {}); }
  assert.equal(await exists(join(handoffOffRoot, 'handoff.sqlite')), false);

  const bothOffRoot = await newRoot();
  const bothOff = await start(bothOffRoot, { disabledModules: ['wiki', 'handoff'] });
  try {
    const disabledPaths = async () => {
      assert.equal(await exists(join(bothOffRoot, 'wiki')), false);
      assert.equal(await exists(join(bothOffRoot, 'handoff.sqlite')), false);
    };
    await disabledPaths();
    assert.equal((await bothOff.request('/v1/modules/wiki/notes?query=x')).status, 404);
    assert.equal((await bothOff.request('/v1/modules/handoff?targetCardId=unused')).status, 404);
    await createCard(bothOff, 'core-only-card');
    const message = await bothOff.request('/v1/cards/core-only-card/messages', {
      method: 'POST', body: { requestId: 'core-only-command', text: 'Core chat remains available.' },
    });
    assert.equal(message.status, 202);
    assert.deepEqual((await commandView(bothOff, 'core-only-command')).result, { status: 'error', code: 'AGENT_NOT_CONFIGURED' });
    await disabledPaths();
    await stop(bothOff.app);
  } finally { await bothOff.app.shutdown('TEST_CLEANUP').catch(() => {}); }
  assert.equal(await exists(join(bothOffRoot, 'wiki')), false);
  assert.equal(await exists(join(bothOffRoot, 'handoff.sqlite')), false);
});
