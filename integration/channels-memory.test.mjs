import assert from 'node:assert/strict';
import test from 'node:test';
import { openChannelStore } from '../channels/store.mjs';
import { createChannelPlane } from '../channels/plane.mjs';
import { createChannelRoutes } from '../channels/hub-routes.mjs';
import { openMemoryStore } from '../memory/store.mjs';
import { createMemoryRoutes } from '../memory/hub-routes.mjs';
import { createHubClient } from '../hub/client.mjs';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { openWorkspaceGraphStore } from '../workspace/graph-store.mjs';

const bearer = 'c'.repeat(64);

test('M6 Hub routes channel messages with acting principal and gates outbound plus memory promotion', async t => {
  const core = openStore(':memory:'), graph = openWorkspaceGraphStore(':memory:');
  const channels = openChannelStore(':memory:'), memory = openMemoryStore(':memory:');
  const sent = []; let runs = 0; let hub;
  const plane = createChannelPlane({ store: channels, graph, core,
    deliver: input => hub.dispatchChannelMessage(input),
    sendOutbound: async ({ message }) => { sent.push(message.id); return { externalId: `sent-${message.id}` }; } });
  const grants = [
    ['card.create', 'write'], ['card.list', 'read'], ['card.read', 'read'], ['session.message', 'write'],
    ['command.read', 'read'], ['events.read', 'read'], ['snapshot.read', 'read'],
    ['channel.read', 'read'], ['channel.write', 'write'], ['memory.read', 'read'], ['memory.write', 'write'],
  ].map(([operation, permission]) => ({ operation, permission, effect: 'allow', projectId: 'project' }));
  hub = createHub({ store: core, graph, bearerSecret: bearer,
    runner: async ({ input }) => { runs++; return { text: `reply:${input.actingPrincipal}` }; },
    authContext: { principalId: 'owner', expiresAt: Date.now() + 60_000, revoked: false, grants },
    resolveTarget: ({ card, input }) => ({ projectId: 'project', cardId: card?.id ?? input.id, sessionId: card?.sessionId ?? input.sessionId }),
    routeHandlers: [
      ...createChannelRoutes({ store: channels, plane, projectId: 'project', ownerId: 'owner' }),
      ...createMemoryRoutes({ store: memory, projectId: 'project' }),
    ] });
  const { port } = await hub.listen();
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${port}`, bearer });
  const call = (method, path, body) => client.moduleRequest({ method, path, body });
  t.after(async () => { await hub.shutdown({ abortActive: true }); channels.close(); memory.close(); graph.close(); core.close(); });
  await client.createCard({ id: 'card', canvasId: 'canvas', sessionId: 'session', title: 'Channel', x: 0, y: 0 }, 'create');
  const bound = await call('POST', '/v1/modules/channels/routes', { channel: 'telegram', accountId: 'account', chatId: 'chat', threadId: 'thread', conversationId: 'card' });
  const route = bound.route;
  const inbound = { routeId: route.id, externalMessageId: 'external-1', actingPrincipal: 'telegram-user-42', text: 'hello' };
  const first = await call('POST', '/v1/modules/channels/inbox', inbound);
  assert.equal(first.message.actingPrincipal, 'telegram-user-42');
  assert.equal(core.getCommand(first.message.commandId).input.actingPrincipal, 'telegram-user-42');
  assert.equal(first.message.handoff.artifacts[0].runId, first.message.commandId);
  assert.equal(first.message.handoff.runs[0].status, 'SUCCEEDED');
  assert.equal((await call('POST', '/v1/modules/channels/inbox', inbound)).duplicate, true);
  assert.equal(runs, 1);
  await call('POST', '/v1/modules/channels/inbox', { ...inbound, externalMessageId: 'external-2' });
  assert.equal(runs, 2);
  await call('POST', `/v1/modules/channels/routes/${route.id}`, { expectedRevision: 1, action: 'PAUSE' });
  await assert.rejects(call('POST', '/v1/modules/channels/inbox', { ...inbound, externalMessageId: 'paused' }), error => error.status === 409);
  assert.deepEqual((await call('POST', '/v1/modules/channels/outbox/flush', {})).messages, []);
  assert.equal(sent.length, 0);
  await assert.rejects(call('POST', `/v1/modules/channels/routes/${route.id}`, { expectedRevision: 1, action: 'RESUME' }), error => error.status === 409);
  await call('POST', `/v1/modules/channels/routes/${route.id}`, { expectedRevision: 2, action: 'RESUME' });
  assert.equal((await call('POST', '/v1/modules/channels/outbox/flush', {})).messages.length, 2);
  assert.deepEqual((await call('POST', '/v1/modules/channels/outbox/flush', {})).messages, []);
  assert.equal(sent.length, 2);
  await call('POST', `/v1/modules/channels/routes/${route.id}`, { expectedRevision: 3, action: 'DETACH' });
  await assert.rejects(call('POST', '/v1/modules/channels/inbox', { ...inbound, externalMessageId: 'detached' }), error => error.status === 409);
  assert.equal((await call('GET', '/v1/modules/channels/outbox')).messages.every(message => message.state === 'SUCCEEDED'), true);

  const proposed = await call('POST', '/v1/modules/memory/proposals', { requestId: 'memory-one', targetId: 'target', baseRevision: 1,
    content: '# memory', worktree: '/srv/aylachi/coding-repos/memory-review', branch: 'review/memory' });
  await assert.rejects(call('POST', `/v1/modules/memory/proposals/${proposed.proposal.id}/review`, { expectedRevision: 1, decision: 'APPROVED' }), error => error.status === 409);
  assert.equal((await call('GET', `/v1/modules/memory/proposals/${proposed.proposal.id}`)).proposal.state, 'PROPOSED');
  await assert.rejects(call('POST', `/v1/modules/memory/proposals/${proposed.proposal.id}/promote`, {}), error => error.status === 404);
});
