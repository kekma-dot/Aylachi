import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persistence/store.mjs';
import { createHub } from '../hub/server.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';

test('real client position writes survive restart; lost receipt reconciles by read without replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-position-http-'));
  const path = join(root, 'state.sqlite');
  const bearer = 'synthetic-position-integration-bearer-not-production';
  let store, hub, baseUrl, dispatches = 0, posts = 0;
  t.after(async () => {
    if (hub) await hub.shutdown();
    if (store) store.close();
    await rm(root, { recursive: true, force: true });
  });
  async function start() {
    store = openStore(path);
    hub = createHub({
      store, bearerSecret: bearer,
      authContext: { principalId: 'fixture-owner', expiresAt: Date.now() + 60_000, revoked: false,
        grants: ['card.update', 'snapshot.read', 'events.read'].map(operation => ({
          effect: 'allow', permission: operation === 'card.update' ? 'write' : 'read', operation, projectId: 'project-a',
        })) },
      resolveTarget: ({ card }) => ({ projectId: 'project-a', cardId: card.id, sessionId: card.sessionId }),
      runner: async () => { dispatches++; throw Error('UNEXPECTED_RUNNER'); },
    });
    const address = await hub.listen();
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  await start();
  store.createCard({ id: 'card-a', canvasId: 'canvas-a', sessionId: 'session-a', title: 'A', x: 0, y: 0 });
  let dropReceipt = false;
  const transport = async (url, options) => {
    if (options.method === 'POST') posts++;
    const response = await fetch(url, options);
    if (dropReceipt && options.method === 'POST' && response.status === 200) {
      dropReceipt = false;
      await response.body.cancel();
      throw Error('SYNTHETIC_RECEIPT_LOST');
    }
    return response;
  };
  let client = createHubClient({ baseUrl, bearer, fetch: transport });
  const moved = await client.moveCard('card-a', { expectedRevision: 1, x: 100, y: -20 });
  assert.equal(moved.card.revision, 2);
  assert.deepEqual([moved.card.x, moved.card.y], [100, -20]);
  assert.equal(posts, 1);
  dropReceipt = true;
  await assert.rejects(client.moveCard('card-a', { expectedRevision: 2, x: 500, y: 600 }),
    error => error.unknownOutcome === true && error.code === 'CONNECTION_FAILED');
  assert.equal(posts, 2, 'lost receipt must not automatically replay POST');
  const authoritative = await client.snapshot('card-a');
  assert.equal(authoritative.card.revision, 3);
  assert.deepEqual([authoritative.card.x, authoritative.card.y], [500, 600]);
  assert.equal(posts, 2, 'reconciliation only reads');
  await assert.rejects(client.moveCard('card-a', { expectedRevision: 2, x: 1, y: 2 }),
    error => error.status === 409 && error.unknownOutcome === false);
  assert.equal(posts, 3);
  assert.deepEqual(store.getCard('card-a'), authoritative.card);
  const events = store.getCardEvents('card-a', 0, 100);
  assert.equal(events.filter(event => event.kind === 'card.updated').length, 2);
  assert.equal(events.some(event => event.kind.startsWith('command.')), false);
  await hub.shutdown(); hub = null;
  store.close(); store = null;
  await start();
  client = createHubClient({ baseUrl, bearer, fetch: transport });
  assert.deepEqual((await client.snapshot('card-a')).card, authoritative.card);
  assert.deepEqual(store.getCardEvents('card-a', 0, 100), events);
  assert.equal(posts, 3);
  assert.equal(dispatches, 0);
});
