import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { openWiki } from '../wiki/wiki.mjs';
import { openWorkspaceGraphStore } from '../workspace/graph-store.mjs';
import { createWorkspaceGraphRoutes } from '../workspace/hub-routes.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';

const bearer = 'g'.repeat(64); // Synthetic test credential.

test('Workspace Graph isolates preview runs and correlates chat and artifact history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-workspace-graph-'));
  const store = openStore(join(root, 'core.sqlite'));
  const graph = openWorkspaceGraphStore(join(root, 'graph.sqlite'));
  const wiki = await openWiki({ root: join(root, 'wiki'), authorize: async ({ actor }) => actor === 'owner' });
  store.createCard({ id: 'chat', canvasId: 'canvas', sessionId: 'session', title: 'Chat', x: 0, y: 0 });
  const grants = ['card.create', 'card.list', 'card.read', 'command.read', 'session.message', 'snapshot.read', 'events.read',
    'workspace.graph.read', 'workspace.graph.write', 'workspace.graph.run'].map(operation => ({ operation, projectId: 'project', effect: 'allow',
    permission: ['card.create', 'session.message', 'workspace.graph.write', 'workspace.graph.run'].includes(operation) ? 'write' : 'read' }));
  const hub = createHub({ store, graph, bearerSecret: bearer, runner: async () => ({ text: 'chat response' }),
    authContext: { principalId: 'owner', expiresAt: Date.now() + 60_000, revoked: false, grants },
    resolveTarget: ({ card, input }) => ({ projectId: 'project', cardId: card?.id ?? input.id, sessionId: card?.sessionId ?? input.sessionId }),
    routeHandlers: createWorkspaceGraphRoutes({ graph, wiki, core: store, projectId: 'project', canvasId: 'canvas', ownerId: 'owner' }) });
  const { port } = await hub.listen();
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${port}`, bearer });
  t.after(async () => { await hub.shutdown({ abortActive: true }); graph.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method, path, body) => client.moduleRequest({ method, path, body });

  const initial = await call('GET', '/v1/modules/workspace/graph');
  assert.equal(initial.nodes.length, 1);
  assert.equal(initial.nodes[0].kind, 'chat');
  const wikiNode = (await call('POST', '/v1/modules/workspace/graph/nodes', { kind: 'wiki', title: 'Research', x: 500, y: 0, content: '# Research\n' })).node;
  const artifactNode = (await call('POST', '/v1/modules/workspace/graph/nodes', { kind: 'artifact', title: 'Diagram', x: 1000, y: 0,
    content: '```mermaid\ngraph LR\n  A-->B\n```', format: 'markdown' })).node;
  assert.equal(wikiNode.settings.content, undefined, 'full Wiki content is not embedded in definition settings');
  assert.equal((await call('GET', `/v1/modules/workspace/graph/nodes/${artifactNode.id}`)).node.settings.content.includes('mermaid'), true);

  const single = await call('POST', '/v1/modules/workspace/graph/runs', { scope: 'node', nodeId: artifactNode.id });
  assert.equal(single.run.nodes.length, 1);
  assert.equal(single.run.nodes[0].nodeId, artifactNode.id);
  assert.equal(single.artifacts[0].runId, single.run.id);
  assert.equal(single.artifacts[0].nodeId, artifactNode.id);
  assert.equal(single.artifacts[0].attempt, 1);
  assert.equal(store.listCards({ canvasId: 'canvas', limit: 10 }).length, 1);

  await call('POST', '/v1/modules/workspace/graph/edges', { sourceNodeId: wikiNode.id, targetNodeId: artifactNode.id, kind: 'context' });
  const branch = await call('POST', '/v1/modules/workspace/graph/runs', { scope: 'branch', nodeId: artifactNode.id });
  assert.deepEqual(new Set(branch.run.nodes.map(node => node.nodeId)), new Set([wikiNode.id, artifactNode.id]));
  assert.equal(branch.run.nodes.some(node => node.nodeId === 'chat'), false, 'side-effect Chat is not executed for preview');
  assert.equal(store.getCardEvents('chat').filter(event => event.kind === 'command.reserved').length, 0);

  const firstContent = (await call('GET', `/v1/modules/workspace/graph/artifacts/${single.artifacts[0].id}`)).artifact.content;
  const updated = await call('POST', `/v1/modules/workspace/graph/nodes/${artifactNode.id}/settings`, {
    expectedRevision: artifactNode.revision, title: 'Diagram v2', content: '# Next run', expectedIgnored: true,
  }).catch(error => error);
  assert.equal(updated.status, 400, 'request with an additional key is rejected before mutation');
  const current = await call('POST', `/v1/modules/workspace/graph/nodes/${artifactNode.id}/settings`, {
    expectedRevision: artifactNode.revision, title: 'Diagram v2', content: '# Next run',
  });
  const second = await call('POST', '/v1/modules/workspace/graph/runs', { scope: 'node', nodeId: artifactNode.id });
  assert.equal(current.node.revision, artifactNode.revision + 1);
  assert.equal(second.artifacts[0].attempt, 3, 'attempts remain monotonic across node and branch runs');
  const delayedOld = await call('GET', `/v1/modules/workspace/graph/artifacts/${single.artifacts[0].id}`);
  assert.equal(delayedOld.artifact.content, firstContent);
  assert.equal(delayedOld.artifact.runId, single.run.id);
  assert.notEqual(delayedOld.artifact.metadata.contentHash, second.artifacts[0].metadata.contentHash);

  const commandId = 'chat-command';
  await client.sendMessage('chat', 'hello', commandId);
  for (let index = 0; index < 100; index++) {
    if ((await client.readCommand(commandId)).command.state === 'COMPLETED') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await client.readCommand(commandId)).command.result.text, 'chat response');
  const final = await call('GET', '/v1/modules/workspace/graph');
  const chatRun = final.runs.find(run => run.id === commandId);
  assert.equal(chatRun.status, 'SUCCEEDED');
  const messageArtifact = final.artifacts.find(artifact => artifact.runId === commandId);
  assert.equal(messageArtifact.nodeId, 'chat');
  assert.equal(messageArtifact.attempt, 1);
  assert.equal(messageArtifact.refId, commandId);
  assert.ok(final.nodes.find(node => node.id === 'chat'));
  assert.ok(final.nodes.find(node => node.id === wikiNode.id));
  assert.ok(final.nodes.find(node => node.id === artifactNode.id));
});
