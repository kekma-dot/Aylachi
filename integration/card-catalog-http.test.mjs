import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persistence/store.mjs';
import { createHub } from '../hub/server.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { createSessionController } from '../desktop-ui/session-controller.mjs';

test('real Hub catalog supplies authoritative non-fixture card IDs to independent connected sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-catalog-http-'));
  const store = openStore(join(root, 'state.sqlite'));
  let hub, controller, legacyController, dispatches = 0;
  t.after(async () => {
    controller?.dispose();
    legacyController?.dispose();
    if (hub) await hub.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const expected = [
    { id: 'actual-alpha', canvasId: 'fixture', sessionId: 'actual-session-alpha', title: 'Server Alpha', x: 12, y: 34, revision: 1 },
    { id: 'actual-beta', canvasId: 'fixture', sessionId: 'actual-session-beta', title: 'Server Beta', x: 56, y: 78, revision: 1 },
  ];
  for (const { revision, ...card } of [...expected].reverse()) store.createCard(card);
  store.createCard({ id: 'hidden', canvasId: 'fixture', sessionId: 'hidden-session', title: 'Must not be listed', x: 0, y: 0 });
  store.createCard({ id: 'other', canvasId: 'another-canvas', sessionId: 'other-session', title: 'Other canvas', x: 0, y: 0 });
  const beforeEvents = store.getEvents(0, 100);
  const bearer = 'synthetic-catalog-http-test-not-a-user-credential';
  hub = createHub({
    store, bearerSecret: bearer,
    authContext: {
      principalId: 'catalog-fixture-owner', expiresAt: Date.now() + 60_000, revoked: false,
      grants: [
        ...['card.list', 'card.read', 'snapshot.read', 'events.read'].map(operation => ({ effect: 'allow', permission: 'read', operation, projectId: 'project-a' })),
        ...['card.create', 'card.update'].map(operation => ({ effect: 'allow', permission: 'write', operation, projectId: 'project-a' })),
        { effect: 'deny', permission: 'read', operation: 'card.read', projectId: 'project-a', cardId: 'hidden' },
      ],
    },
    resolveTarget({ operation, input, card }) {
      if (card) return { projectId: 'project-a', cardId: card.id, sessionId: card.sessionId };
      if (operation === 'card.create' && input.id === 'legacy-finite' && input.canvasId === 'fixture' && input.sessionId === 'legacy-session') return { projectId: 'project-a', cardId: input.id, sessionId: input.sessionId };
      if (operation === 'card.list' && input.canvasId === 'fixture') return { projectId: 'project-a' };
      return null;
    },
    runner: async () => { dispatches++; throw Error('UNEXPECTED_RUNNER'); },
  });
  const address = await hub.listen();
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, bearer });
  const result = await client.listCards('fixture');
  assert.deepEqual(result.cards, expected);
  assert.ok(!JSON.stringify(result).includes('hidden'));
  controller = createSessionController({ client, cards: result.cards });
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().cards, expected);
  assert.deepEqual(controller.getSnapshot().statusBySession, {
    'actual-session-alpha': 'ready', 'actual-session-beta': 'ready',
  });
  await assert.rejects(client.listCards('another-canvas'), error => error.status === 404 && !error.unknownOutcome);
  assert.deepEqual(store.getEvents(0, 100), beforeEvents);
  assert.equal(dispatches, 0);

  // Reads preserve legacy finite positions; an explicit move remains bounded.
  const created = await client.createCard({ id: 'legacy-finite', canvasId: 'fixture', sessionId: 'legacy-session', title: 'Legacy finite', x: 1_000_001, y: -1_000_001 }, 'create-legacy');
  assert.equal(created.card.x, 1_000_001);
  const legacyCatalog = await client.listCards('fixture');
  assert.equal(legacyCatalog.cards.find(card => card.id === 'legacy-finite').x, 1_000_001);
  legacyController = createSessionController({ client, cards: legacyCatalog.cards });
  await legacyController.refresh();
  store.updateCard('legacy-finite', 1, { x: 1_000_002 });
  await legacyController.refresh();
  const legacy = legacyController.getSnapshot().cards.find(card => card.id === 'legacy-finite');
  assert.equal(legacy.x, 1_000_002);
  assert.equal(legacy.y, -1_000_001);
  assert.equal(legacy.revision, 2);
  assert.deepEqual(await legacyController.move({ id: legacy.id, canvasId: legacy.canvasId, sessionId: legacy.sessionId, revision: legacy.revision, x: 10, y: 20 }), { accepted: true });
  assert.equal(store.getCard('legacy-finite').revision, 3);
  assert.deepEqual([store.getCard('legacy-finite').x, store.getCard('legacy-finite').y], [10, 20]);
  assert.equal(dispatches, 0);
});
