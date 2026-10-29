import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persistence/store.mjs';
import { createHub } from '../hub/server.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { createSessionController } from '../desktop-ui/session-controller.mjs';

test('real catalog addition preserves lost-receipt identity and independent parent/child history without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-catalog-add-'));
  let store, hub, controller, release;
  const parentGate = new Promise(resolve => { release = resolve; });
  const messagePosts = [], effects = [];
  let loseParentReceipt = true;
  try {
    store = openStore(join(root, 'hub.sqlite'));
    const parent = store.createCard({ id: 'parent', canvasId: 'canvas', sessionId: 'parent-session', title: 'Parent', x: 1_000_001, y: -1_000_001 });
    const bearer = 'synthetic-catalog-add-only-not-an-account-credential';
    hub = createHub({ store, bearerSecret: bearer,
      authContext: { principalId: 'owner', expiresAt: Date.now() + 60000, revoked: false,
        grants: ['card.list','card.read','snapshot.read','events.read','command.read','card.create','session.message'].map(operation => ({ effect: 'allow', permission: ['card.create','session.message'].includes(operation) ? 'write' : 'read', operation, projectId: 'project' })) },
      resolveTarget({ operation, input, card }) {
        if (card) return { projectId: 'project', cardId: card.id, sessionId: card.sessionId };
        if (operation === 'card.list' && input.canvasId === 'canvas') return { projectId: 'project' };
        if (operation === 'card.create' && input.canvasId === 'canvas') return { projectId: 'project', cardId: input.id, sessionId: input.sessionId };
        return null;
      },
      async runner({ card }) {
        effects.push(card.id);
        if (card.id === parent.id) await parentGate;
        return { text: `${card.id} result` };
      },
    });
    const address = await hub.listen();
    const client = createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, bearer,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (init.method === 'POST' && path.endsWith('/messages')) messagePosts.push(path);
        const response = await fetch(url, init);
        if (loseParentReceipt && path === '/v1/cards/parent/messages' && init.method === 'POST') {
          loseParentReceipt = false;
          assert.equal(response.status, 202);
          await response.body.cancel();
          throw new Error('committed receipt lost');
        }
        return response;
      },
    });
    const ids = ['parent-send', 'child-send'];
    controller = createSessionController({ client, cards: (await client.listCards('canvas')).cards, newId: () => ids.shift() });
    await controller.refresh();
    const pending = await controller.send({ cardId: parent.id, sessionId: parent.sessionId, text: 'preserve this original draft' });
    assert.equal(pending.accepted, false);
    assert.equal(store.getCommand('parent-send').state, 'RUNNING');
    const before = controller.getSnapshot();
    assert.equal(before.messagesBySession[parent.sessionId][0].id, 'parent-send-user');
    assert.equal(before.statusBySession[parent.sessionId], 'reconciliation');
    const child = { id: 'child', canvasId: 'canvas', sessionId: 'child-session', title: 'Child', x: 50, y: 50 };
    await client.createCard(child, 'server-child-create');
    store.updateCard(parent.id, 1, { x: 17, y: 21 });
    const catalog = (await client.listCards('canvas')).cards;
    const postsBefore = [...messagePosts];
    assert.deepEqual(controller.addCards(catalog), { added: 1 });
    const added = controller.getSnapshot();
    assert.deepEqual(added.messagesBySession[parent.sessionId], before.messagesBySession[parent.sessionId]);
    assert.equal(added.statusBySession[parent.sessionId], 'reconciliation');
    assert.equal(added.statusBySession[child.sessionId], 'disconnected');
    assert.equal(added.cards.find(card => card.id === parent.id).x, 1_000_001, 'catalog must not overwrite snapshot/position authority');
    assert.deepEqual(messagePosts, postsBefore, 'adding a catalog cannot dispatch any work');
    assert.equal((await controller.send({ cardId: child.id, sessionId: child.sessionId, text: 'child task' })).accepted, false);
    assert.deepEqual(messagePosts, postsBefore, 'unsynchronized child cannot send');
    await controller.refresh();
    assert.equal(controller.getSnapshot().statusBySession[child.sessionId], 'ready');
    assert.equal(controller.getSnapshot().cards.find(card => card.id === parent.id).x, 17);
    const reconciled = await controller.send({ cardId: parent.id, sessionId: parent.sessionId, text: 'preserve this original draft' });
    assert.equal(reconciled.accepted, true);
    assert.equal(messagePosts.filter(path => path === '/v1/cards/parent/messages').length, 1, 'parent must reuse its unknown-outcome request via GET, not replay');
    assert.equal((await controller.send({ cardId: child.id, sessionId: child.sessionId, text: 'child task' })).accepted, true);
    release();
    for (let attempt = 0; attempt < 100 && store.getCommand('parent-send').state === 'RUNNING'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    await controller.refresh();
    const final = controller.getSnapshot();
    assert.ok(final.messagesBySession[parent.sessionId].some(message => message.text === 'parent result'));
    assert.ok(final.messagesBySession[child.sessionId].some(message => message.text === 'child result'));
    assert.ok(!final.messagesBySession[child.sessionId].some(message => message.text === 'preserve this original draft'));
    assert.deepEqual(effects.sort(), ['child', 'parent']);
    assert.deepEqual(controller.addCards(catalog), { added: 0 });
  } finally {
    release(); controller?.dispose(); await hub?.shutdown({ abortActive: true }); store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
