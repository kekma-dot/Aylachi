import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persistence/store.mjs';
import { createHub } from '../hub/server.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { createSessionController } from '../desktop-ui/session-controller.mjs';

const identity = card => ({ id: card.id, canvasId: card.canvasId, sessionId: card.sessionId, revision: card.revision });

test('rename, resize and move share CAS revisions and survive reopen without losing dimensions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-card-controls-'));
  const path = join(root, 'state.sqlite');
  let store = openStore(path);
  store.createCard({ id: 'card-a', canvasId: 'canvas', sessionId: 'session-a', title: 'Original', x: 10, y: 20 });
  const bearer = 'synthetic-card-controls-not-a-real-credential';
  const operations = ['card.create', 'card.list', 'card.read', 'card.update', 'snapshot.read', 'events.read', 'command.read'];
  const hub = createHub({
    store, bearerSecret: bearer, runner: async () => { throw new Error('unexpected runner'); }, now: () => 1,
    authContext: { principalId: 'owner', expiresAt: 100, revoked: false,
      grants: operations.map(operation => ({ effect: 'allow', permission: operation === 'card.list' || operation.endsWith('.read') ? 'read' : 'write', operation, projectId: 'project' })) },
    resolveTarget: ({ operation, card, input }) => card
      ? { projectId: 'project', cardId: card.id, sessionId: card.sessionId }
      : operation === 'card.list' ? { projectId: 'project' }
        : { projectId: 'project', cardId: input.id, sessionId: input.sessionId },
  });
  const address = await hub.listen();
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, bearer });
  let controller;
  t.after(async () => {
    controller?.dispose();
    await hub.shutdown({ abortActive: true });
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const catalog = await client.listCards('canvas');
  assert.equal(Object.hasOwn(catalog.cards[0], 'width'), false, 'legacy card shape remains unchanged');
  controller = createSessionController({ client, cards: catalog.cards });
  await controller.refresh();
  let card = controller.getSnapshot().cards[0];

  assert.deepEqual(await controller.rename({ ...identity(card), title: 'Research' }), { accepted: true });
  card = controller.getSnapshot().cards[0];
  assert.equal(card.title, 'Research');
  assert.equal(card.revision, 2);

  assert.deepEqual(await controller.resize({ ...identity(card), x: 30, y: 40, width: 640, height: 700 }), { accepted: true });
  card = controller.getSnapshot().cards[0];
  assert.deepEqual([card.x, card.y, card.width, card.height, card.revision], [30, 40, 640, 700, 3]);
  assert.deepEqual((await client.listCards('canvas')).cards[0], card);

  assert.deepEqual(await controller.move({ ...identity(card), x: 50, y: 60 }), { accepted: true });
  card = controller.getSnapshot().cards[0];
  assert.deepEqual([card.x, card.y, card.width, card.height, card.revision], [50, 60, 640, 700, 4]);
  assert.equal((await controller.rename({ ...identity(card), revision: 3, title: 'Stale' })).message, 'STALE_POSITION');
  assert.equal(store.getCard('card-a').title, 'Research');

  const high = { modelProvider: 'openai-codex', modelId: 'gpt-6-luna', reasoning: 'high' };
  assert.equal(store.updateCard('card-a', card.revision, high).revision, 5);
  card = store.getCard('card-a');
  store.reserveCommand({ id: 'running-model-change', cardId: card.id, input: { operation: 'session.message', text: 'busy' } });
  assert.throws(() => store.updateCard('card-a', card.revision, { ...high, reasoning: 'medium' }), /MODEL_SETTINGS_BUSY/);
  assert.equal(store.getCard('card-a').reasoning, 'high');
  store.completeCommand('running-model-change', { status: 'ok', value: { text: 'done' } });
  assert.equal(store.updateCard('card-a', card.revision, { ...high, reasoning: 'medium' }).reasoning, 'medium');
  card = store.getCard('card-a');

  controller.dispose();
  controller = null;
  const persisted = openStore(path);
  assert.deepEqual(persisted.getCard('card-a'), card);
  persisted.close();

  const reopened = createSessionController({ client, cards: [store.getCard('card-a')] });
  controller = reopened;
  await reopened.refresh();
  assert.deepEqual(reopened.getSnapshot().cards[0], card);
  assert.deepEqual(await reopened.resize({ ...identity(card), x: 70, y: 80, width: 700, height: 720 }), { accepted: true });
  assert.deepEqual(reopened.getSnapshot().cards[0].reasoning, 'medium');
});
