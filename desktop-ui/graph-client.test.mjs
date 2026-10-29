import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphClient } from './graph-client.mjs';

const node = { id: 'node', canvasId: 'fixture', kind: 'artifact', refId: 'node', title: 'Artifact', x: 0, y: 0, width: 520, height: 520, revision: 1, settings: {} };
const artifact = { id: 'artifact', runId: 'run', nodeId: 'node', attempt: 1, kind: 'artifact-preview', refId: 'node', revision: null, state: 'SUCCEEDED', metadata: {}, createdAt: 1, content: '# One' };

test('graph client uses authoritative routes and validates node/artifact identity', async () => {
  const calls = [];
  const hubClient = { moduleRequest: async request => {
    calls.push(request);
    if (request.path.endsWith('/graph')) return { nodes: [node], edges: [], runs: [], artifacts: [] };
    if (request.path.endsWith('/artifacts/artifact')) return { artifact };
    if (request.path.endsWith('/nodes')) return { node };
    return { node };
  } };
  const client = createGraphClient({ hubClient });
  assert.equal((await client.snapshot()).nodes[0].id, 'node');
  assert.equal((await client.artifact('artifact')).artifact.content, '# One');
  await client.createNode({ kind: 'artifact', title: 'A', x: 0, y: 0 });
  await client.updateArtifact('node', { expectedRevision: 1, title: 'A', content: '# Two' });
  assert.equal(calls[2].method, 'POST');
  assert.equal(calls[2].path, '/v1/modules/workspace/graph/nodes');
  assert.equal(calls[3].body.content, '# Two');
  await assert.rejects(() => createGraphClient({ hubClient: { moduleRequest: async () => ({ nodes: [{}], edges: [], runs: [], artifacts: [] }) } }).snapshot(), /INVALID_GRAPH_RESPONSE/);
});
