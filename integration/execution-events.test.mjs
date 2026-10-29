import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persistence/store.mjs';
import { createHub } from '../hub/server.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { createSessionController } from '../desktop-ui/session-controller.mjs';

const bearer = 'synthetic-execution-events-not-a-real-credential';
const card = { id: 'card-a', canvasId: 'canvas', sessionId: 'session-a', title: 'Live', x: 0, y: 0 };
const operations = ['card.create', 'card.read', 'snapshot.read', 'events.read', 'command.read', 'session.message', 'delegation.delegate'];
async function until(fn, message = 'condition did not settle') {
  for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
function makeHub(store, runner, routeHandlers = []) {
  return createHub({ store, bearerSecret: bearer, runner, routeHandlers, now: () => 1,
    authContext: { principalId: 'owner', expiresAt: 100, revoked: false,
      grants: operations.map(operation => ({ effect: 'allow', permission: operation.endsWith('.read') ? 'read' : 'write', operation, projectId: 'project' })) },
    resolveTarget: ({ card, input }) => ({ projectId: 'project', cardId: card?.id ?? input.id, sessionId: card?.sessionId ?? input.sessionId }) });
}

test('live transient text and durable tools replay once after Hub restart; late delta stays closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-execution-events-'));
  const store = openStore(join(root, 'state.sqlite'));
  store.createCard(card);
  let release, lateEmit;
  let hub = makeHub(store, async ({ emit }) => {
    lateEmit = emit;
    emit({ type: 'text.delta', sessionId: card.sessionId, turnId: 'turn-live', itemId: 'turn-live:assistant', eventId: 'delta-1', payload: { text: 'Hello' } });
    emit({ type: 'tool.started', sessionId: card.sessionId, turnId: 'turn-live', itemId: 'turn-live:tool:call1', eventId: 'turn-live:call1:started', payload: { toolName: 'read' } });
    emit({ type: 'text.delta', sessionId: card.sessionId, turnId: 'turn-live', itemId: 'turn-live:assistant', eventId: 'delta-2', payload: { text: ' world' } });
    emit({ type: 'tool.completed', sessionId: card.sessionId, turnId: 'turn-live', itemId: 'turn-live:tool:call1', eventId: 'turn-live:call1:completed', payload: { toolName: 'read', isError: false } });
    await new Promise(resolve => { release = resolve; });
    return { text: 'Hello world' };
  });
  let address = await hub.listen();
  let client = createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, bearer });
  let controller;
  const controllers = new Set();
  t.after(async () => {
    release?.();
    for (const item of controllers) item.dispose();
    await hub.shutdown({ abortActive: true });
    store.close(); await rm(root, { recursive: true, force: true });
  });
  controller = createSessionController({ client, cards: [store.getCard(card.id)], newId: () => 'turn-live' }); controllers.add(controller);
  await controller.refresh();
  assert.deepEqual(await controller.send({ cardId: card.id, sessionId: card.sessionId, text: 'work' }), { accepted: true });
  await until(() => {
    const state = controller.getSnapshot();
    const assistant = state.messagesBySession[card.sessionId].find(message => message.role === 'assistant');
    return assistant?.provisional && assistant.text === 'Hello world' && state.activitiesBySession[card.sessionId][0]?.status === 'completed';
  }, 'live assistant and tool activity did not appear before completion');
  assert.equal(store.getCommand('turn-live').state, 'RUNNING');
  const durableBefore = store.getCardEvents(card.id, 0, 100);
  assert.equal(durableBefore.some(event => event.payload?.type === 'text.delta'), false, 'transient deltas must not enter SQLite');
  assert.deepEqual(durableBefore.filter(event => event.kind === 'execution.event').map(event => event.payload.type),
    ['turn.started', 'item.started', 'tool.started', 'tool.completed']);

  controller.dispose(); controllers.delete(controller);
  controller = createSessionController({ client, cards: [store.getCard(card.id)], newId: () => 'turn-live' }); controllers.add(controller);
  await controller.refresh();
  await until(() => controller.getSnapshot().messagesBySession[card.sessionId].some(message => message.role === 'assistant' && message.provisional));
  const reconnected = controller.getSnapshot();
  assert.equal(reconnected.activitiesBySession[card.sessionId].length, 1);
  assert.deepEqual(reconnected.messagesBySession[card.sessionId].filter(message => message.role === 'assistant').map(message => [message.text, message.provisional]),
    [['Hello world', true]], 'same-Hub transient replay is deduplicated by event_id');

  release(); await until(() => store.getCommand('turn-live').state === 'COMPLETED');
  await controller.refresh();
  const finalState = controller.getSnapshot();
  assert.deepEqual(finalState.messagesBySession[card.sessionId].map(message => [message.role, message.text, Boolean(message.provisional)]),
    [['user', 'work', false], ['assistant', 'Hello world', false]]);
  assert.equal(finalState.activitiesBySession[card.sessionId][0].status, 'completed');
  const countBeforeLate = store.getCardEvents(card.id, 0, 100).length;
  lateEmit({ type: 'text.delta', sessionId: card.sessionId, turnId: 'turn-live', itemId: 'turn-live:assistant', eventId: 'late-delta', payload: { text: 'LATE' } });
  await controller.refresh();
  assert.equal(store.getCardEvents(card.id, 0, 100).length, countBeforeLate);
  assert.equal(controller.getSnapshot().messagesBySession[card.sessionId].at(-1).text, 'Hello world');
  controller.dispose(); controllers.delete(controller);

  const completedEvents = store.getCardEvents(card.id, 0, 100);
  const finalCursor = completedEvents.at(-1).sequence;
  const resumeAfter = completedEvents.find(event => event.payload?.type === 'tool.started').sequence;
  await hub.shutdown();
  hub = makeHub(store, async () => { throw new Error('no replay after restart'); });
  address = await hub.listen();
  client = createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, bearer });
  const replayed = [];
  const abort = new AbortController();
  const streaming = client.streamEvents({ cardId: card.id, afterSeq: resumeAfter, signal: abort.signal,
    onEvent: record => { replayed.push(record); if (record.event.type === 'turn.completed') abort.abort(); } });
  await assert.rejects(streaming, error => error.code === 'ABORTED');
  const execution = replayed.filter(record => record.durable);
  assert.ok(execution.length >= 3);
  assert.ok(execution.every(record => record.seq > resumeAfter), 'after_seq excludes the already persisted prefix');
  assert.equal(new Set(execution.map(record => record.seq)).size, execution.length, 'replay has no duplicate durable seq');
  assert.ok(execution.every((record, index) => index === 0 || record.seq > execution[index - 1].seq));
  assert.equal(replayed.some(record => record.event.type === 'text.delta'), false);
  assert.equal(replayed.filter(record => record.event.type === 'item.completed').length, 1);
  assert.equal(replayed.find(record => record.event.type === 'item.completed').event.payload.text, 'Hello world');
  assert.ok(finalCursor > 0);
  assert.equal((await client.readCommand('turn-live')).command.result.text, 'Hello world', 'legacy completed-command client remains compatible');
});

test('durable effect approval is visible and binds the same attempt and payload hash', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-effect-ui-'));
  const store = openStore(join(root, 'state.sqlite'));
  store.createCard(card);
  store.reserveCommand({ id: 'turn-effect', cardId: card.id, input: { operation: 'session.message', text: 'delegate' } });
  const effectId = 'effect-approval';
  const payloadHash = 'a'.repeat(64);
  let hub;
  const approvalRoute = { method: 'POST', path: '/v1/modules/delegation-effects/:id/approval', operation: 'delegation.delegate', effect: 'write', target: { projectId: 'project' },
    handle: async ({ params, body }) => {
      assert.equal(params.id, effectId);
      assert.deepEqual(body, { parentCommandId: 'turn-effect', attempt: 1, payloadHash });
      hub.appendModuleExecution('turn-effect', 'tool.effect', effectId, `${effectId}:1:SUCCEEDED`,
        { toolName: 'delegate_task', state: 'SUCCEEDED', attempt: 1, payloadHash, reasonCode: null });
      return { status: 200, body: { ok: true } };
    } };
  hub = makeHub(store, async () => ({ text: 'unused' }), [approvalRoute]);
  const address = await hub.listen();
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, bearer });
  const controller = createSessionController({ client, cards: [store.getCard(card.id)] });
  t.after(async () => { controller.dispose(); await hub.shutdown({ abortActive: true }); store.close(); await rm(root, { recursive: true, force: true }); });
  hub.appendModuleExecution('turn-effect', 'tool.effect', effectId, `${effectId}:1:PENDING_APPROVAL`,
    { toolName: 'delegate_task', state: 'PENDING_APPROVAL', attempt: 1, payloadHash, reasonCode: null });
  await controller.refresh();
  assert.equal(controller.getSnapshot().activitiesBySession[card.sessionId][0].status, 'approval');
  assert.deepEqual(await controller.approveEffect({ cardId: card.id, sessionId: card.sessionId, turnId: 'turn-effect', effectId, expectedAttempt: 1, payloadHash }), { accepted: true });
  const activity = controller.getSnapshot().activitiesBySession[card.sessionId][0];
  assert.equal(activity.status, 'completed');
  assert.equal(activity.reasonCode, null);
});
