import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendRegistry } from '../backends/registry.mjs';
import { createBackendRoutes } from '../backends/hub-routes.mjs';
import { openBackendStore } from '../backends/store.mjs';
import { createHubClient } from '../hub/client.mjs';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { startDevelopmentServer } from '../runtime/server.mjs';

const bearer = 'b'.repeat(64);

test('Hub isolates two backend conversations and keeps default switching away from existing bindings', async t => {
  const core = openStore(':memory:'), backendStore = openBackendStore(':memory:');
  const calls = [];
  const adapter = id => ({ id, revision: 1, capabilities: ['chat', 'events'],
    async health() { return { state: 'READY' }; },
    async run({ card, commandId, backend }) { calls.push({ id, cardId: card.id, sessionId: card.sessionId, commandId, backend }); return { text: `${id}:${card.sessionId}` }; } });
  const registry = createBackendRegistry({ store: backendStore, adapters: [adapter('pi'), adapter('synthetic')] });
  const grants = [
    ['card.create', 'write'], ['card.list', 'read'], ['card.read', 'read'], ['session.message', 'write'],
    ['command.read', 'read'], ['events.read', 'read'], ['snapshot.read', 'read'], ['backend.read', 'read'], ['backend.write', 'write'],
  ].map(([operation, permission]) => ({ operation, permission, effect: 'allow', projectId: 'project' }));
  const hub = createHub({ store: core, bearerSecret: bearer, backends: registry, runner: async () => { throw new Error('unused'); },
    authContext: { principalId: 'owner', expiresAt: Date.now() + 60_000, revoked: false, grants },
    resolveTarget: ({ card, input }) => ({ projectId: 'project', cardId: card?.id ?? input.id, sessionId: card?.sessionId ?? input.sessionId }),
    routeHandlers: createBackendRoutes({ registry, projectId: 'project', ownerId: 'owner' }) });
  const { port } = await hub.listen();
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${port}`, bearer });
  t.after(async () => { await hub.shutdown({ abortActive: true }); await registry.shutdown(); backendStore.close(); core.close(); });
  const call = (method, path, body) => client.moduleRequest({ method, path, body });
  const a = await client.createCard({ id: 'card-a', canvasId: 'canvas', sessionId: 'session-a', title: 'A', x: 0, y: 0 }, 'create-a');
  const b = await client.createCard({ id: 'card-b', canvasId: 'canvas', sessionId: 'session-b', title: 'B', x: 0, y: 0, backendId: 'synthetic' }, 'create-b');
  assert.equal(a.backend.backendId, 'pi'); assert.equal(b.backend.backendId, 'synthetic');
  await client.sendMessage('card-a', 'run A', 'command-a'); await client.sendMessage('card-b', 'run B', 'command-b');
  for (const id of ['command-a', 'command-b']) {
    for (let index = 0; index < 100; index++) {
      const command = (await client.readCommand(id)).command;
      if (command.state === 'COMPLETED') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  assert.equal((await client.readCommand('command-a')).command.result.text, 'pi:session-a');
  assert.equal((await client.readCommand('command-b')).command.result.text, 'synthetic:session-b');
  assert.deepEqual(new Set(calls.map(call => call.id)), new Set(['pi', 'synthetic']));
  assert.equal(calls.find(call => call.cardId === 'card-a').sessionId, 'session-a');
  assert.equal(calls.find(call => call.cardId === 'card-b').sessionId, 'session-b');
  const before = registry.conversation('card-a');
  await call('POST', '/v1/modules/backends/default', { backendId: 'synthetic' });
  assert.deepEqual(registry.conversation('card-a'), before);
  const replayA = await client.createCard({ id: 'card-a', canvasId: 'canvas', sessionId: 'session-a', title: 'A', x: 0, y: 0 }, 'create-a');
  assert.equal(replayA.duplicate, true);
  assert.equal(replayA.backend.backendId, 'pi');
  const third = await client.createCard({ id: 'card-c', canvasId: 'canvas', sessionId: 'session-c', title: 'C', x: 0, y: 0 }, 'create-c');
  assert.equal(third.backend.backendId, 'synthetic');
  assert.equal((await call('GET', '/v1/modules/backends/conversations/card-a')).conversation.backendId, 'pi');
  assert.equal((await call('GET', '/v1/modules/backends/health')).backends.length, 2);
});

test('runtime plugin disable preserves core and Pi backend binding survives restart', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-backend-runtime-'));
  let app, disposed = 0;
  const plugin = { id: 'optional', version: '1', apiVersion: 5, owner: 'fixture', capabilities: ['tools'],
    activate: () => ({ dispose: () => { disposed++; }, health: () => ({ state: 'READY' }) }) };
  const connect = async () => {
    const bearer = (await readFile(join(root, '.bearer'), 'utf8')).trim();
    return createHubClient({ baseUrl: `http://127.0.0.1:${app.address.port}`, bearer });
  };
  try {
    app = await startDevelopmentServer({ stateRoot: root, port: 0, plugins: [plugin] });
    let client = await connect();
    const created = await client.createCard({ id: 'card', canvasId: 'fixture', sessionId: 'session', title: 'Core', x: 0, y: 0 }, 'create');
    assert.equal(created.backend.backendId, 'pi');
    const call = (method, path, body) => client.moduleRequest({ method, path, body });
    assert.equal((await call('POST', '/v1/modules/plugins/optional', { action: 'activate' })).plugin.status, 'ACTIVE');
    assert.equal((await call('POST', '/v1/modules/plugins/optional', { action: 'disable' })).plugin.status, 'DISABLED');
    assert.equal(disposed, 1);
    await client.createCard({ id: 'core-after-disable', canvasId: 'fixture', sessionId: 'core-after-disable', title: 'Still works', x: 0, y: 0 }, 'create-after-disable');
    assert.equal((await call('GET', '/v1/modules/backends/conversations/card')).conversation.sessionId, 'session');
    await app.shutdown(); app = undefined;
    app = await startDevelopmentServer({ stateRoot: root, port: 0 });
    client = await connect();
    assert.equal((await client.moduleRequest({ method: 'GET', path: '/v1/modules/backends/conversations/card' })).conversation.backendId, 'pi');
    assert.equal((await client.moduleRequest({ method: 'GET', path: '/v1/modules/plugins' })).plugins.length, 0);
    assert.equal((await client.listCards('fixture')).cards.length, 2);
  } finally {
    if (app) await app.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
