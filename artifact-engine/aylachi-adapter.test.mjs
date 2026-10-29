import assert from 'node:assert/strict';
import test from 'node:test';
import { createAylachiArtifactAdapter } from './aylachi-adapter.mjs';
import { createArtifactEngine } from './engine.mjs';
import { openArtifactStore } from './store.mjs';
import { openWorkspaceGraphStore } from '../workspace/graph-store.mjs';

test('Aylachi adapter correlates engine versions with one graph node and replays creation', () => {
  const artifacts = openArtifactStore(':memory:');
  const graph = openWorkspaceGraphStore(':memory:');
  const engine = createArtifactEngine({ store: artifacts });
  const adapter = createAylachiArtifactAdapter({ engine, graph, canvasId: 'fixture' });
  const request = { idempotencyKey: 'session:turn:call', title: 'Diagram', format: 'mermaid', content: 'graph TD; A-->B', sources: [], origin: { kind: 'pi', sessionId: 'session', turnId: 'turn', toolCallId: 'call' } };
  const first = adapter.create(request), replay = adapter.create(request);
  assert.equal(first.artifact.id, replay.artifact.id);
  assert.equal(replay.idempotent, true);
  assert.equal(graph.listNodes('fixture').length, 1);
  assert.equal(first.node.refId, first.artifact.id);
  const correlated = graph.getArtifact(`artifact-${first.artifact.id}-v1-output`);
  assert.equal(correlated.state, 'SUCCEEDED');
  assert.equal(correlated.content, request.content);
  assert.equal(correlated.attempt, 1);
  const updated = adapter.update(first.node, 1, 'Diagram v2', 'graph TD; A-->C');
  assert.equal(updated.version.version, 2);
  assert.equal(updated.node.revision, 2);
  assert.equal(adapter.current(updated.node).version.content, 'graph TD; A-->C');
  const restored = adapter.rollback(updated.node, 2, 1, 'rollback-one');
  assert.equal(restored.version.version, 3);
  assert.equal(restored.version.content, request.content);
  assert.equal(graph.snapshot('fixture').runs.length, 3);
  graph.close(); artifacts.close();
});

test('stale graph CAS cannot commit a hidden artifact version', () => {
  const artifacts = openArtifactStore(':memory:'), graph = openWorkspaceGraphStore(':memory:');
  const engine = createArtifactEngine({ store: artifacts });
  const adapter = createAylachiArtifactAdapter({ engine, graph, canvasId: 'fixture' });
  const created = adapter.create({ idempotencyKey: 'create', title: 'Artifact', format: 'markdown', content: 'one', sources: [], origin: { kind: 'aylachi' } });
  assert.throws(() => adapter.update(created.node, 0, 'Stale', 'hidden commit'), /REVISION_CONFLICT/);
  assert.equal(adapter.current(created.node).artifact.currentVersion, 1);
  assert.throws(() => adapter.rollback(created.node, 0, 1, 'stale-rollback'), /REVISION_CONFLICT/);
  assert.equal(adapter.current(created.node).artifact.currentVersion, 1);
  graph.close(); artifacts.close();
});
