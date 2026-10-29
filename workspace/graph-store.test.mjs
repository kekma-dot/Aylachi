import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspaceGraphStore, requiredSubgraph, graphContentHash } from './graph-store.mjs';

const canvasId = 'fixture';
const card = { id: 'chat-1', canvasId, sessionId: 'session-1', title: 'Chat', x: 0, y: 0, width: 460, height: 520, revision: 1 };
const artifact = (id, title = 'Artifact') => ({ id, canvasId, kind: 'artifact', refId: id, title, x: 100, y: 100, settings: { content: '# One', format: 'markdown' } });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aylachi-graph-'));
  const path = join(root, 'graph.sqlite');
  const store = openWorkspaceGraphStore(path, { now: () => 1000 });
  let active = true;
  t.after(() => { if (active) { store.close(); rmSync(root, { recursive: true, force: true }); } });
  return { store, path, root, close() { store.close(); active = false; } };
}

test('graph stores typed definitions and rejects cycles', t => {
  const { store } = fixture(t);
  store.syncChatCards([card]);
  store.createNode(artifact('a'));
  store.createNode(artifact('b'));
  store.createEdge({ edgeId: 'a-b', canvasId, sourceNodeId: 'a', targetNodeId: 'b' });
  assert.throws(() => store.createEdge({ edgeId: 'b-a', canvasId, sourceNodeId: 'b', targetNodeId: 'a' }), /GRAPH_CYCLE/);
  assert.throws(() => store.createEdge({ edgeId: 'self', canvasId, sourceNodeId: 'a', targetNodeId: 'a' }), /INVALID_EDGE/);
  const snapshot = store.snapshot(canvasId);
  assert.deepEqual(snapshot.nodes.map(node => node.kind), ['chat', 'artifact', 'artifact']);
  assert.equal(snapshot.edges[0].kind, 'context');
});

test('chat run syncs its definition even before the first graph read', t => {
  const { store } = fixture(t);
  const command = { id: 'command-before-read', input: { text: 'hello' } };
  store.beginChatRun(command, card);
  store.completeRun(command.id, 'SUCCEEDED');
  const snapshot = store.snapshot(canvasId);
  assert.equal(snapshot.runs[0].id, command.id);
  assert.equal(snapshot.artifacts[0].nodeId, card.id);
});

test('node, branch and all resolve different subgraphs', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const edges = [{ sourceNodeId: 'a', targetNodeId: 'c' }, { sourceNodeId: 'b', targetNodeId: 'c' }];
  assert.deepEqual(requiredSubgraph(nodes, edges, 'c', 'node'), ['c']);
  assert.deepEqual(requiredSubgraph(nodes, edges, 'c', 'branch'), ['a', 'b', 'c']);
  assert.deepEqual(requiredSubgraph(nodes, edges, null, 'all'), ['a', 'b', 'c']);
});

test('artifact snapshots retain run, node, attempt and immutable content across reopen', t => {
  const { store, path, root, close } = fixture(t);
  store.createNode(artifact('a'));
  const first = store.startRun({ runId: 'run-1', canvasId, rootNodeId: 'a', scope: 'node', items: [{ nodeId: 'a', inputHash: graphContentHash('# One'),
    artifact: { id: 'artifact-1', kind: 'artifact-preview', refId: 'a', revision: graphContentHash('# One'), content: '# One', metadata: { contentHash: graphContentHash('# One') } } }] });
  store.completeRun(first.id, 'SUCCEEDED');
  store.updateArtifact('a', 1, 'Artifact', '# Two');
  store.startRun({ runId: 'run-2', canvasId, rootNodeId: 'a', scope: 'node', items: [{ nodeId: 'a', inputHash: graphContentHash('# Two'),
    artifact: { id: 'artifact-2', kind: 'artifact-preview', refId: 'a', revision: graphContentHash('# Two'), content: '# Two', metadata: { contentHash: graphContentHash('# Two') } } }] });
  store.completeRun('run-2', 'SUCCEEDED');
  close();
  const reopened = openWorkspaceGraphStore(path);
  t.after(() => { reopened.close(); rmSync(root, { recursive: true, force: true }); });
  const oldArtifact = reopened.getArtifact('artifact-1');
  assert.equal(oldArtifact.content, '# One');
  assert.equal(oldArtifact.runId, 'run-1');
  assert.equal(oldArtifact.nodeId, 'a');
  assert.equal(oldArtifact.attempt, 1);
  assert.equal(reopened.getArtifact('artifact-2').attempt, 2);
  assert.equal(reopened.getNode('a').revision, 2);
  assert.equal(reopened.snapshot(canvasId).runs.length, 2);
});

test('layout CAS and artifact CAS preserve independent definition revisions', t => {
  const { store } = fixture(t);
  store.createNode(artifact('a'));
  assert.throws(() => store.updateLayout('a', 2, { x: 1, y: 2, width: 500, height: 500 }), /REVISION_CONFLICT/);
  const moved = store.updateLayout('a', 1, { x: 1, y: 2, width: 500, height: 500 });
  assert.equal(moved.revision, 2);
  assert.throws(() => store.updateArtifact('a', 1, 'Nope', 'bad'), /REVISION_CONFLICT/);
  assert.equal(store.updateArtifact('a', 2, 'Renamed', '# Next').revision, 3);
});

test('restart recovery marks unfinished runs and artifacts unknown without inventing success', t => {
  const { store } = fixture(t);
  store.createNode(artifact('a'));
  store.startRun({ runId: 'run-1', canvasId, rootNodeId: 'a', scope: 'node', items: [{ nodeId: 'a',
    artifact: { id: 'artifact-1', kind: 'artifact-preview', refId: 'a', content: '# One', metadata: {} } }] });
  assert.equal(store.recoverRunning(), 1);
  assert.equal(store.snapshot(canvasId).runs[0].status, 'UNKNOWN');
  assert.equal(store.getArtifact('artifact-1').state, 'UNKNOWN');
  assert.throws(() => store.completeRun('run-1', 'SUCCEEDED'), /RUN_STATE_CONFLICT/);
});
