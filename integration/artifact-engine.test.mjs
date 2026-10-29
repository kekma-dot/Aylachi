import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAylachiArtifactAdapter } from '../artifact-engine/aylachi-adapter.mjs';
import { createArtifactEngine } from '../artifact-engine/engine.mjs';
import { createArtifactRoutes } from '../artifact-engine/hub-routes.mjs';
import { openArtifactStore } from '../artifact-engine/store.mjs';
import { createHubClient } from '../hub/client.mjs';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';
import { openWorkspaceGraphStore } from '../workspace/graph-store.mjs';
import { createWorkspaceGraphRoutes } from '../workspace/hub-routes.mjs';

const bearer = 'a'.repeat(64);

test('one artifact engine serves agent, Canvas, versions, export and idempotent retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-artifact-integration-'));
  const core = openStore(join(root, 'core.sqlite'));
  const graph = openWorkspaceGraphStore(join(root, 'graph.sqlite'));
  const artifactStore = openArtifactStore(join(root, 'artifacts.sqlite'));
  const engine = createArtifactEngine({ store: artifactStore });
  const adapter = createAylachiArtifactAdapter({ engine, graph, canvasId: 'canvas' });
  const grants = ['artifact.read', 'artifact.write', 'workspace.graph.read', 'workspace.graph.write', 'workspace.graph.run'].map(operation => ({
    operation, projectId: 'project', effect: 'allow', permission: operation.endsWith('read') ? 'read' : 'write' }));
  const routes = [
    ...createArtifactRoutes({ engine, adapter, graph, projectId: 'project', canvasId: 'canvas', ownerId: 'owner' }),
    ...createWorkspaceGraphRoutes({ graph, core, artifacts: adapter, projectId: 'project', canvasId: 'canvas', ownerId: 'owner' }),
  ];
  const hub = createHub({ store: core, graph, bearerSecret: bearer, runner: async () => ({ text: 'unused' }),
    authContext: { principalId: 'owner', expiresAt: Date.now() + 60_000, revoked: false, grants },
    resolveTarget: ({ card, input }) => ({ projectId: 'project', cardId: card?.id ?? input?.id, sessionId: card?.sessionId ?? input?.sessionId }),
    routeHandlers: routes });
  const { port } = await hub.listen();
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${port}`, bearer });
  t.after(async () => { await hub.shutdown({ abortActive: true }); artifactStore.close(); graph.close(); core.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method, path, body) => client.moduleRequest({ method, path, body });
  const request = { idempotencyKey: 'agent-request-one', title: 'Roadmap', format: 'markdown', content: '# One\n',
    sources: [{ uri: 'https://example.com/spec', label: 'Spec', snapshot: 'source v1\n' }], origin: { kind: 'pi', sessionId: 'session', turnId: 'turn', toolCallId: 'call|fc' } };
  const first = await call('POST', '/v1/modules/artifacts', request);
  const replay = await call('POST', '/v1/modules/artifacts', request);
  assert.equal(replay.artifact.id, first.artifact.id);
  assert.equal(replay.idempotent, true);
  assert.equal((await call('GET', '/v1/modules/artifacts')).artifacts.length, 1);
  const snapshot = await call('GET', '/v1/modules/workspace/graph');
  assert.equal(snapshot.nodes.filter(node => node.kind === 'artifact').length, 1);
  assert.equal(snapshot.artifacts.find(artifact => artifact.refId === first.artifact.id).state, 'SUCCEEDED');
  const node = (await call('GET', `/v1/modules/workspace/graph/nodes/${encodeURIComponent(first.node.id)}`)).node;
  assert.equal(node.settings.content, '# One\n');
  const updated = await call('POST', `/v1/modules/workspace/graph/nodes/${first.node.id}/settings`, { expectedRevision: 1, title: 'Roadmap v2', content: '# Two\n' });
  assert.equal(updated.version.version, 2);
  const exported = await call('GET', `/v1/modules/artifacts/${first.artifact.id}/export?version=1`);
  assert.equal(exported.content, '# One\n');
  assert.equal(exported.manifest.sources[0].snapshot, 'source v1\n');
  const rolledBack = await call('POST', `/v1/modules/artifacts/${first.artifact.id}/rollback`, { targetVersion: 1, expectedRevision: 2, idempotencyKey: 'rollback-request' });
  assert.equal(rolledBack.version.version, 3);
  assert.equal(rolledBack.version.content, '# One\n');
  assert.equal((await call('GET', `/v1/modules/artifacts/${first.artifact.id}/versions`)).versions.length, 3);
  const html = await call('POST', '/v1/modules/artifacts', { ...request, idempotencyKey: 'html-request', title: 'HTML', format: 'html', content: '<h1>Safe preview</h1>', sources: [] });
  assert.equal((await call('GET', `/v1/modules/workspace/graph/nodes/${encodeURIComponent(html.node.id)}`)).node.settings.format, 'html');
});

test('post-commit event failure does not turn an exact artifact into a tool failure', async () => {
  const result = { artifact: { id: 'artifact-one', title: 'One', currentVersion: 1 },
    version: { artifactId: 'artifact-one', version: 1, title: 'One', content: '# One', contentHash: 'a'.repeat(64), sources: [], origin: { kind: 'pi', turnId: 'turn' } },
    node: { id: 'artifact-node-artifact-one' } };
  const routes = createArtifactRoutes({ engine: {}, adapter: { create: () => result, nodeIdFor: id => `artifact-node-${id}` },
    graph: {}, projectId: 'project', canvasId: 'canvas', ownerId: 'owner', onVersion: () => { throw new Error('synthetic publication failure'); } });
  const create = routes.find(route => route.method === 'POST' && route.path === '/v1/modules/artifacts');
  const response = await create.handle({ actor: 'owner', query: {}, body: { idempotencyKey: 'request', title: 'One', format: 'markdown', content: '# One', sources: [], origin: { kind: 'pi', turnId: 'turn' } } });
  assert.equal(response.status, 201);
  assert.equal(response.body.artifact.id, 'artifact-one');
  assert.equal(response.body.eventPublished, false);
});
