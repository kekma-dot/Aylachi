import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persistence/store.mjs';
import { createHub } from '../hub/server.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';

test('new chat uses real Hub idempotency and read-only lost-receipt reconciliation without model effects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-new-chat-http-'));
  const store = openStore(join(root, 'state.sqlite'));
  let hub, dispatches = 0, posts = 0, loseReceipt = true;
  t.after(async () => {
    if (hub) await hub.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const bearer = 'synthetic-new-chat-test-not-a-user-credential';
  hub = createHub({
    store, bearerSecret: bearer,
    authContext: {
      principalId: 'new-chat-fixture', expiresAt: Date.now() + 60000, revoked: false,
      grants: [
        { effect: 'allow', permission: 'write', operation: 'card.create', projectId: 'project-new-chat' },
        ...['card.list', 'card.read', 'snapshot.read', 'events.read'].map(operation => ({ effect: 'allow', permission: 'read', operation, projectId: 'project-new-chat' })),
      ],
    },
    resolveTarget({ operation, input, card }) {
      if (card) return { projectId: 'project-new-chat', cardId: card.id, sessionId: card.sessionId };
      if (operation === 'card.list' && input.canvasId === 'fixture') return { projectId: 'project-new-chat' };
      if (operation === 'card.create' && input.canvasId === 'fixture' && input.id !== 'denied') return { projectId: 'project-new-chat', cardId: input.id, sessionId: input.sessionId };
      return null;
    },
    runner: async () => { dispatches++; throw Error('UNEXPECTED_MODEL_DISPATCH'); },
  });
  const address = await hub.listen();
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, bearer,
    async fetch(url, options) {
      const response = await fetch(url, options);
      if (options.method === 'POST' && new URL(url).pathname === '/v1/cards') {
        posts++;
        if (loseReceipt) {
          loseReceipt = false;
          await response.body?.cancel();
          throw Error('synthetic lost receipt after server commit');
        }
      }
      return response;
    },
  });
  assert.deepEqual(await client.listCards('fixture'), { cards: [] });
  const card = { id: 'created-chat', canvasId: 'fixture', sessionId: 'created-session', title: 'New chat', x: 0, y: 0 };
  const requestId = 'stable-create-intent';
  await assert.rejects(client.createCard(card, requestId), failure => failure.unknownOutcome === true);
  assert.equal(posts, 1);
  assert.deepEqual(store.getCard(card.id), { ...card, revision: 1 });
  const eventsAfterCommit = store.getEvents(0, 100);

  // A read proves the existing mapping; it must not silently replay the POST.
  const catalog = await client.listCards('fixture');
  assert.deepEqual(catalog.cards, [{ ...card, revision: 1 }]);
  assert.equal(posts, 1);
  const duplicate = await client.createCard(card, requestId); // Explicit same-intent retry only.
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.card, { ...card, revision: 1 });
  assert.equal(posts, 2);
  assert.deepEqual(store.getEvents(0, 100), eventsAfterCommit);

  await assert.rejects(client.createCard({ ...card, title: 'Changed intent' }, requestId), failure => failure.status === 409 && !failure.unknownOutcome);
  assert.deepEqual(store.getCard(card.id), { ...card, revision: 1 });
  await assert.rejects(client.createCard({ ...card, id: 'denied', sessionId: 'denied-session' }, 'denied-create'), failure => failure.status >= 400 && failure.status < 500 && !failure.unknownOutcome);
  assert.ok(!store.getCard('denied'));
  assert.equal((await client.listCards('fixture')).cards.length, 1);
  assert.equal(dispatches, 0);
});
