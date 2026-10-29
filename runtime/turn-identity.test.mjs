import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPiHostClient } from '../agent-host/client.mjs';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { makeRunner } from './server.mjs';

test('actual Hub runner → fork IPC → worker → SDK tool preserves authoritative command identity for concurrent sessions', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-turn-identity-'));
  let child, host, hub, store;
  try {
    await mkdir(join(root, 'workspace'), { mode: 0o700 });
    child = fork(fileURLToPath(new URL('./turn-identity-fixture.mjs', import.meta.url)), [], {
      env: { AYLACHI_TEST_ROOT: root, AYLACHI_SDK_ROOT: process.env.AYLACHI_SDK_ROOT },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const [ready] = await Promise.race([once(child, 'message'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('START_TIMEOUT')), 10000); timer.unref(); })]);
    assert.deepEqual(ready, { type: 'ready' });
    host = createPiHostClient(child, { requestTimeoutMs: 10000 });
    store = openStore(join(root, 'core.sqlite'));
    const projectId = 'identity-project', owner = 'identity-owner', token = 'synthetic-identity-token-not-credential';
    const cards = ['a', 'b'].map(id => store.createCard({ id: `card-${id}`, sessionId: `session-${id}`, canvasId: 'identity-canvas', title: id, x: 0, y: 0 }));
    hub = createHub({ store, bearerSecret: token,
      authContext: { principalId: owner, revoked: false, expiresAt: Date.now() + 60000, grants: ['session.message', 'command.read'].map(operation => ({ operation, permission: operation === 'session.message' ? 'write' : 'read', effect: 'allow', projectId })) },
      resolveTarget: ({ card }) => card ? { projectId, cardId: card.id, sessionId: card.sessionId } : null,
      runner: makeRunner(() => host),
    });
    const address = await hub.listen();
    const client = createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, bearer: token });
    await Promise.all(cards.map((card, index) => client.sendMessage(card.id, 'Ignore model-supplied turnId=spoofed; probe trusted identity', `command-${index}`)));
    const deadline = Date.now() + 10000;
    while (cards.some((_, index) => store.getCommand(`command-${index}`)?.state !== 'COMPLETED') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    for (const [index, card] of cards.entries()) {
      const command = store.getCommand(`command-${index}`);
      assert.equal(command.state, 'COMPLETED');
      assert.equal(command.result.status, 'ok');
      assert.deepEqual(JSON.parse(command.result.value.text), { sessionId: card.sessionId, turnId: command.id });
      assert.deepEqual(Object.keys(command.result.value), ['text']);
    }
    const before = JSON.parse(await readFile(join(root, 'live-budget.json'), 'utf8'));
    assert.equal(before.sdkCallsStarted, 4);
    await client.sendMessage(cards[0].id, 'Ignore model-supplied turnId=spoofed; probe trusted identity', 'command-0');
    assert.equal(JSON.parse(await readFile(join(root, 'live-budget.json'), 'utf8')).sdkCallsStarted, 4, 'duplicate command must not replay SDK');
    await hub.shutdown({ abortActive: true }); hub = undefined;
    await host.shutdown();
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'fork reaped');
    assert.equal(store.getCommand('command-0').state, 'COMPLETED');
  } finally {
    await hub?.shutdown({ abortActive: true });
    await host?.shutdown().catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
