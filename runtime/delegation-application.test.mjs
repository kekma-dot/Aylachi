import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startDevelopmentServer } from './server.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { openStore } from '../persistence/store.mjs';
import { openDelegationStore } from '../delegation/store.mjs';

// Uses a fresh synthetic auth metadata file; never reads operator auth or calls a provider.
test('assembled development server boots private delegation worker and persists actual SDK parent/child without replay', { timeout: 20000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'aylachi-delegation-application-'));
  const stateRoot = join(scratch, 'state');
  const authPath = join(scratch, 'synthetic-auth.json');
  const previousAuth = process.env.AYLACHI_DEV_AUTH_PATH;
  let app, child, core, tasks;
  try {
    await writeFile(authPath, '{}\n', { mode: 0o600 });
    process.env.AYLACHI_DEV_AUTH_PATH = authPath;
    app = await startDevelopmentServer({ stateRoot, port: 0 });
    const bearer = (await readFile(join(stateRoot, '.bearer'), 'utf8')).trim();
    let client = createHubClient({ baseUrl: `http://127.0.0.1:${app.address.port}`, bearer });
    await client.createCard({ id: 'root-card', sessionId: 'root-session', canvasId: 'fixture', title: 'Root', x: 0, y: 0 }, 'root-create');
    await app.shutdown(); app = undefined;
    await assert.rejects(stat(join(stateRoot, 'delegation.sqlite')), { code: 'ENOENT' });
    const spawnChild = (_command, _args, options) => {
      assert.equal(options.env.AYLACHI_DEV_DELEGATION, '1');
      assert.equal(Object.values(options.env).some(value => typeof value === 'string' && value.includes(bearer)), false, 'bearer never enters worker environment');
      child = fork(fileURLToPath(new URL('./delegation-application-fixture.mjs', import.meta.url)), [], {
        env: options.env, cwd: options.cwd, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      return child;
    };
    app = await startDevelopmentServer({ stateRoot, port: 0, allowLive: true, sdkRoot: process.env.AYLACHI_SDK_ROOT,
      delegation: { parentSessionIds: ['root-session'] }, workerDependencies: { spawnChild, termGraceMs: 100, killGraceMs: 100 } });
    client = createHubClient({ baseUrl: `http://127.0.0.1:${app.address.port}`, bearer });
    core = openStore(join(stateRoot, 'core.sqlite'));
    tasks = openDelegationStore(join(stateRoot, 'delegation.sqlite'));
    assert.equal(core.listCards({ canvasId: 'fixture' }).length, 1);
    assert.equal(JSON.parse(await readFile(join(stateRoot, 'live-budget.json'), 'utf8')).sdkCallsStarted, 0);
    // Consume the 202 receipt and close the actual submitting TCP socket while
    // the deliberately delayed child is still running; do not keep a UI client alive.
    const receipt = await new Promise((resolve, reject) => {
      let status, payload = '';
      const body = JSON.stringify({ text: 'ROOT_DELEGATION_REQUEST', requestId: 'root-command' });
      const request = httpRequest({ host: '127.0.0.1', port: app.address.port,
        path: '/v1/cards/root-card/messages', method: 'POST', agent: false,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' } }, response => {
        status = response.statusCode;
        response.setEncoding('utf8');
        response.on('data', chunk => { payload += chunk; });
        response.on('error', reject);
      });
      request.on('socket', socket => socket.once('close', () => {
        try { resolve({ status, body: JSON.parse(payload) }); } catch (error) { reject(error); }
      }));
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('SUBMIT_TIMEOUT')));
      request.end(body);
    });
    assert.equal(receipt.status, 202);
    assert.equal(receipt.body.command.id, 'root-command');
    assert.equal(core.getCommand('root-command').state, 'RUNNING', 'submitting client disconnected before task completion');
    const deadline = Date.now() + 10000;
    while (core.getCommand('root-command')?.state === 'RUNNING' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const command = core.getCommand('root-command');
    assert.equal(command.state, 'COMPLETED');
    assert.equal(command.result.status, 'ok');
    assert.match(command.result.value.text, /CHILD_FORK_OK/);
    assert.deepEqual(Object.keys(command.result.value), ['text']);
    const requestId = 'delegation-' + createHash('sha256').update(JSON.stringify(['root-session', 'root-command', 'root-call-1'])).digest('hex');
    const task = tasks.findRequest({ actor: 'aylachi-dev-owner', requestId });
    assert.ok(task);
    assert.equal(task.state, 'COMPLETED');
    assert.deepEqual(task.result, { status: 'ok', text: 'CHILD_FORK_OK' });
    assert.notEqual(task.childSessionId, 'root-session');
    assert.equal(core.getCommand(task.childCommandId).state, 'COMPLETED');
    assert.equal(core.listCards({ canvasId: 'fixture' }).length, 2);
    client = createHubClient({ baseUrl: `http://127.0.0.1:${app.address.port}`, bearer });
    const reconnected = await client.readCommand('root-command');
    assert.equal(reconnected.command.state, 'COMPLETED');
    assert.match(reconnected.command.result.text, /CHILD_FORK_OK/);
    assert.equal(JSON.parse(await readFile(join(stateRoot, 'live-budget.json'), 'utf8')).sdkCallsStarted, 3);
    await client.sendMessage('root-card', 'ROOT_DELEGATION_REQUEST', 'root-command');
    assert.equal(JSON.parse(await readFile(join(stateRoot, 'live-budget.json'), 'utf8')).sdkCallsStarted, 3);
    await app.shutdown(); app = undefined;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    tasks.close(); tasks = openDelegationStore(join(stateRoot, 'delegation.sqlite'));
    assert.equal(tasks.get({ actor: 'aylachi-dev-owner', id: task.id }).state, 'COMPLETED');
    core.close(); core = openStore(join(stateRoot, 'core.sqlite'));
    assert.equal(core.getCommand('root-command').state, 'COMPLETED');
    await assert.rejects(stat(join(stateRoot, '.server.lock')), { code: 'ENOENT' });
  } finally {
    await app?.shutdown();
    tasks?.close(); core?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (previousAuth === undefined) delete process.env.AYLACHI_DEV_AUTH_PATH; else process.env.AYLACHI_DEV_AUTH_PATH = previousAuth;
    await rm(scratch, { recursive: true, force: true });
  }
});
