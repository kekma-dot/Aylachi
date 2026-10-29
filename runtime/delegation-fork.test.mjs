import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPiHostClient } from '../agent-host/client.mjs';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { openDelegationStore } from '../delegation/store.mjs';
import { createDelegationModule } from '../delegation/hub-routes.mjs';
import { makeRunner } from './server.mjs';

test('forked actual SDK parent delegates through runtime tools/client/Hub to separate child session without replay', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-delegation-fork-'));
  let child, host, hub, core, tasks, client;
  try {
    await mkdir(join(root, 'workspace'), { mode: 0o700 });
    core = openStore(join(root, 'core.sqlite'));
    tasks = openDelegationStore(join(root, 'tasks.sqlite'));
    const projectId = 'fork-project', actor = 'fork-owner', canvasId = 'fork-canvas';
    const token = 'synthetic-delegation-fork-token-not-credential';
    const parent = core.createCard({ id: 'root-card', sessionId: 'root-session', canvasId, title: 'Root', x: 0, y: 0 });
    const resolveParent = ({ actor: requestedActor, parentCommandId, action }) => {
      const command = core.getCommand(parentCommandId);
      const card = command && core.getCard(command.cardId);
      if (requestedActor !== actor || card?.id !== parent.id || card.sessionId !== parent.sessionId || card.canvasId !== canvasId || action === 'delegate' && command.state !== 'RUNNING') return null;
      return { actor, parentCommandId, parentCardId: card.id, canvasId };
    };
    const bridge = { createCard: (...args) => client.createCard(...args), sendMessage: (...args) => client.sendMessage(...args), readCommand: (...args) => client.readCommand(...args), cancelCommand: () => { throw new Error('UNEXPECTED_CANCEL'); } };
    const routes = createDelegationModule({ store: tasks, hubClient: bridge, projectId, resolveParent, approve: () => true, pollIntervalMs: 5, waitTimeoutMs: 4000 });
    const writes = new Set(['card.create', 'session.message', 'delegation.delegate']);
    hub = createHub({ store: core, bearerSecret: token,
      authContext: { principalId: actor, revoked: false, expiresAt: Date.now() + 60000,
        grants: ['card.create', 'card.list', 'card.read', 'session.message', 'command.read', 'delegation.delegate', 'delegation.read'].map(operation => ({ operation, permission: writes.has(operation) ? 'write' : 'read', effect: 'allow', projectId })) },
      resolveTarget: ({ card, input }) => ({ projectId, ...(card ? { cardId: card.id, sessionId: card.sessionId } : input?.id ? { cardId: input.id, sessionId: input.sessionId } : {}) }),
      routeHandlers: routes, runner: makeRunner(() => host),
    });
    const address = await hub.listen();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    client = createHubClient({ baseUrl, bearer: token });
    child = fork(fileURLToPath(new URL('./delegation-fork-fixture.mjs', import.meta.url)), [], {
      env: { AYLACHI_TEST_ROOT: root, AYLACHI_TEST_HUB_URL: baseUrl, AYLACHI_SDK_ROOT: process.env.AYLACHI_SDK_ROOT },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const [ready] = await Promise.race([once(child, 'message'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('START_TIMEOUT')), 10000); timer.unref(); })]);
    assert.deepEqual(ready, { type: 'ready' });
    host = createPiHostClient(child, { requestTimeoutMs: 10000 });
    assert.equal(core.listCards({ canvasId }).length, 1, 'no startup child dispatch');
    await client.sendMessage(parent.id, 'ROOT_DELEGATION_REQUEST', 'root-command');
    const deadline = Date.now() + 10000;
    while (core.getCommand('root-command')?.state === 'RUNNING' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const command = core.getCommand('root-command');
    assert.equal(command.state, 'COMPLETED');
    assert.equal(command.result.status, 'ok');
    assert.match(command.result.value.text, /CHILD_FORK_OK/);
    assert.deepEqual(Object.keys(command.result.value), ['text']);
    const requestId = 'delegation-' + createHash('sha256').update(JSON.stringify(['root-session', 'root-command', 'root-call-1'])).digest('hex');
    const task = tasks.findRequest({ actor, requestId });
    assert.ok(task, 'stable request identity comes from trusted command and SDK call');
    assert.equal(task.state, 'COMPLETED');
    assert.deepEqual(task.result, { status: 'ok', text: 'CHILD_FORK_OK' });
    assert.notEqual(task.childSessionId, parent.sessionId);
    assert.equal(core.getCommand(task.childCommandId).state, 'COMPLETED');
    assert.equal(core.listCards({ canvasId }).length, 2);
    const budget = JSON.parse(await readFile(join(root, 'live-budget.json'), 'utf8'));
    assert.equal(budget.sdkCallsStarted, 3, 'two parent turns and one no-tool child turn');
    await client.sendMessage(parent.id, 'ROOT_DELEGATION_REQUEST', 'root-command');
    assert.equal(JSON.parse(await readFile(join(root, 'live-budget.json'), 'utf8')).sdkCallsStarted, 3);
    assert.equal(core.listCards({ canvasId }).length, 2);
    await hub.shutdown({ abortActive: true }); hub = undefined;
    await host.shutdown();
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    await hub?.shutdown({ abortActive: true });
    await host?.shutdown().catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    tasks?.close(); core?.close();
    await rm(root, { recursive: true, force: true });
  }
});
