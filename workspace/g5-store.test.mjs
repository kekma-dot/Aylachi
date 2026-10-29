import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorkspaceGraphStore } from './graph-store.mjs';

test('typed pipes validate ports, stay inert and survive reopen', t => {
  const root = mkdtempSync(join(tmpdir(), 'aylachi-g5-store-')), path = join(root, 'graph.sqlite');
  let store = openWorkspaceGraphStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const source = store.createNode({ id: 'source', canvasId: 'canvas', kind: 'plugin', refId: 'acme.unseen.source', title: 'Source', x: 0, y: 0,
    settings: { toolName: 'acme.unseen.source', input: {}, ports: [{ id: 'out', direction: 'output', dataType: 'text' }] } });
  const target = store.createNode({ id: 'target', canvasId: 'canvas', kind: 'plugin', refId: 'acme.unseen.target', title: 'Target', x: 600, y: 0,
    settings: { toolName: 'acme.unseen.target', input: {}, ports: [{ id: 'in', direction: 'input', dataType: 'text' }] } });
  assert.equal(source.kind, 'plugin'); assert.equal(target.settings.ports[0].dataType, 'text');
  assert.throws(() => store.createEdge({ canvasId: 'canvas', sourceNodeId: 'source', targetNodeId: 'target', kind: 'pipe',
    sourcePortId: 'out', targetPortId: 'in', dataType: 'json' }), /PIPE_TYPE_MISMATCH/);
  assert.throws(() => store.createEdge({ canvasId: 'canvas', sourceNodeId: 'source', targetNodeId: 'target', kind: 'pipe',
    sourcePortId: 'in', targetPortId: 'out', dataType: 'text' }), /PIPE_PORT_NOT_FOUND/);
  const pipe = store.createEdge({ edgeId: 'pipe-1', canvasId: 'canvas', sourceNodeId: 'source', targetNodeId: 'target', kind: 'pipe',
    sourcePortId: 'out', targetPortId: 'in', dataType: 'text' });
  assert.equal(pipe.dataType, 'text'); assert.equal(store.snapshot('canvas').runs.length, 0, 'creating a pipe executes nothing');
  store.close();
  store = openWorkspaceGraphStore(path);
  assert.deepEqual(store.snapshot('canvas').edges[0], pipe);
  assert.equal(store.snapshot('canvas').nodes.length, 2);
});
