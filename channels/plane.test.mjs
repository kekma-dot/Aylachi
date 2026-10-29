import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persistence/store.mjs';
import { openWorkspaceGraphStore } from '../workspace/graph-store.mjs';
import { openChannelStore } from './store.mjs';
import { createChannelPlane } from './plane.mjs';

function fixture(store, sent = []) {
  const core = openStore(':memory:'), graph = openWorkspaceGraphStore(':memory:');
  const card = core.createCard({ id: 'card', canvasId: 'canvas', sessionId: 'session', title: 'Channel', x: 0, y: 0 });
  let deliveries = 0;
  const plane = createChannelPlane({ store, graph, core, async deliver({ cardId, requestId, text, actingPrincipal }) {
    deliveries++;
    const target = core.getCard(cardId);
    const { command } = core.reserveCommand({ id: requestId, cardId, input: { operation: 'session.message', text, actingPrincipal } });
    if (command.state === 'RUNNING') {
      graph.beginChatRun(command, target);
      core.completeCommand(requestId, { status: 'ok', value: { text: `reply:${actingPrincipal}` } });
      graph.completeRun(requestId, 'SUCCEEDED');
    }
    return core.getCommand(requestId);
  }, async sendOutbound({ route, message }) { sent.push({ route: route.id, message: message.id }); return { externalId: `sent-${message.id}` }; } });
  return { core, graph, plane, card, sent, deliveries: () => deliveries };
}

test('channel ingest preserves acting principal and graph handoff; pause/detach gate both directions', async t => {
  const store = openChannelStore(':memory:'), fixtureValue = fixture(store);
  t.after(() => { store.close(); fixtureValue.core.close(); fixtureValue.graph.close(); });
  const { route } = store.bind({ channel: 'telegram', accountId: 'account', chatId: 'chat', threadId: 'thread', conversationId: 'card' });
  const input = { externalMessageId: 'message-1', actingPrincipal: 'user-42', text: 'hello' };
  const first = await fixtureValue.plane.ingest(route.id, input);
  assert.equal(first.duplicate, false);
  assert.equal(first.message.actingPrincipal, 'user-42');
  assert.equal(first.message.handoff.source.commandId, first.message.commandId);
  assert.equal(first.message.handoff.runs[0].status, 'SUCCEEDED');
  assert.equal(first.message.handoff.artifacts[0].runId, first.message.commandId);
  assert.equal(fixtureValue.core.getCommand(first.message.commandId).input.actingPrincipal, 'user-42');
  assert.equal((await fixtureValue.plane.ingest(route.id, input)).duplicate, true);
  assert.equal(fixtureValue.deliveries(), 1);
  const paused = store.updateRoute(route.id, 1, 'PAUSE');
  assert.equal(paused.revision, 2);
  const pausedReplay = await fixtureValue.plane.ingest(route.id, input);
  assert.equal(pausedReplay.duplicate, true);
  assert.equal(fixtureValue.deliveries(), 1);
  await assert.rejects(fixtureValue.plane.ingest(route.id, { ...input, externalMessageId: 'message-2' }), /CHANNEL_ROUTE_PAUSED/);
  assert.deepEqual(await fixtureValue.plane.flush(), []);
  assert.equal(fixtureValue.sent.length, 0);
  assert.throws(() => store.updateRoute(route.id, 1, 'RESUME'), /CHANNEL_REVISION_CONFLICT/);
  store.updateRoute(route.id, 2, 'RESUME');
  assert.equal((await fixtureValue.plane.flush()).length, 1);
  assert.deepEqual(await fixtureValue.plane.flush(), []);
  assert.equal(fixtureValue.sent.length, 1);
  const detached = store.updateRoute(route.id, 3, 'DETACH');
  assert.equal(detached.state, 'DETACHED');
  await assert.rejects(fixtureValue.plane.ingest(route.id, { ...input, externalMessageId: 'message-3' }), /CHANNEL_ROUTE_DETACHED/);
  assert.deepEqual(await fixtureValue.plane.flush(), []);
  assert.throws(() => store.updateRoute(route.id, 4, 'RESUME'), /CHANNEL_STATE_CONFLICT/);
});

test('outbox restart replays exact receipt without duplicate sends and recovers SENDING as UNKNOWN', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-channel-store-'));
  const path = join(root, 'channels.sqlite');
  let store = openChannelStore(path), value = fixture(store);
  const { route } = store.bind({ channel: 'hermes', accountId: 'account', chatId: 'chat', threadId: 'root', conversationId: 'card' });
  await value.plane.ingest(route.id, { externalMessageId: 'one', actingPrincipal: 'user', text: 'hello' });
  await value.plane.flush();
  store.close(); value.core.close(); value.graph.close();
  store = openChannelStore(path); value = fixture(store);
  assert.equal(value.plane.recover(), 0);
  assert.deepEqual(await value.plane.flush(), []);
  assert.equal(store.outbound()[0].state, 'SUCCEEDED');
  await value.plane.ingest(route.id, { externalMessageId: 'two', actingPrincipal: 'user', text: 'again' });
  const pending = store.pendingOutbound()[0];
  store.beginOutbound(pending.id);
  store.close(); value.core.close(); value.graph.close();
  store = openChannelStore(path); value = fixture(store);
  t.after(async () => { store.close(); value.core.close(); value.graph.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(value.plane.recover(), 1);
  assert.equal(store.outbound().find(message => message.id === pending.id).state, 'UNKNOWN');
  assert.deepEqual(await value.plane.flush(), []);
  assert.equal(value.sent.length, 0);
});
