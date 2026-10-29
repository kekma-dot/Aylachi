import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDevelopmentServer } from './server.mjs';
import { createSatelliteClient } from '../satellite/client.mjs';
import { openSatelliteExecutionStore } from '../satellite/execution-store.mjs';
import { createGraphClient } from '../desktop-ui/graph-client.mjs';

const secret = 'e'.repeat(64);
const registration = { id: 'sat-g5', secret, tools: ['acme.unseen.transform'], capabilities: ['acme.transform'] };
const tool = { name: 'acme.unseen.transform', title: 'Unseen transform', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  sideEffect: false, idempotent: true, requiresApproval: false, capabilities: ['acme.transform'] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function desktop(app, token) {
  return createGraphClient({ hubClient: { async moduleRequest({ method, path, body }) {
    const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, { method, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error ?? 'HUB_ERROR'), { code: value.error ?? 'HUB_ERROR' });
    return value;
  } } });
}
async function activity(client, requestId) {
  for (let index = 0; index < 300; index++) {
    const snapshot = await client.snapshot();
    const item = snapshot.activities.find(activity => activity.runId === requestId);
    if (item && ['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(item.state)) return { snapshot, item };
    await sleep(10);
  }
  throw new Error('G5_ACTIVITY_TIMEOUT');
}

test('G5 shared Canvas, explicit Trigger, GUI-independent Activity and durable unknown plugin node', { timeout: 30_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'aylachi-g5-runtime-')), stateRoot = join(scratch, 'state');
  const options = { stateRoot, port: 0, satellite: { registrations: [registration], port: 0 } };
  let app = await startDevelopmentServer(options), client, executionStore, effects = 0;
  t.after(async () => { await client?.stop(); executionStore?.close(); if (app) await app.shutdown(); await rm(scratch, { recursive: true, force: true }); });
  const token = (await readFile(join(stateRoot, '.bearer'), 'utf8')).trim();
  executionStore = openSatelliteExecutionStore(join(scratch, 'client.sqlite'));
  client = createSatelliteClient({ baseUrl: `http://127.0.0.1:${app.satelliteAddress.port}`, satelliteId: registration.id, secret, executionStore, pollIntervalMs: 5,
    connectors: [{ manifest: { id: 'acme-unseen', kind: 'native', version: '1.0.0', tools: [tool] },
      async execute({ payload }) { effects++; await sleep(40); return { text: payload.value.toUpperCase() }; } }] });
  await client.start();
  let desktopA = desktop(app, token), desktopB = desktop(app, token);
  const created = await desktopA.createNode({ kind: 'plugin', title: 'Unseen plugin', x: 80, y: 80, toolName: tool.name, input: { value: 'hello' },
    ports: [{ id: 'in', direction: 'input', dataType: 'json' }, { id: 'out', direction: 'output', dataType: 'json' }] });
  const target = await desktopA.createNode({ kind: 'plugin', title: 'Second generic node', x: 680, y: 80, toolName: tool.name, input: {},
    ports: [{ id: 'in', direction: 'input', dataType: 'json' }, { id: 'out', direction: 'output', dataType: 'json' }] });
  assert.equal((await desktopB.snapshot()).nodes.filter(node => node.kind === 'plugin').length, 2, 'second desktop sees the same Canvas');
  await desktopA.createEdge({ sourceNodeId: created.node.id, targetNodeId: target.node.id, kind: 'pipe', sourcePortId: 'out', targetPortId: 'in', dataType: 'json' });
  assert.equal((await desktopB.snapshot()).runs.length, 0, 'pipe alone is inert');
  const triggered = await desktopA.trigger({ requestId: 'g5-trigger-1', nodeId: created.node.id, input: { value: 'hello' } });
  assert.equal(triggered.command.requestId, 'g5-trigger-1');
  await assert.rejects(() => desktopB.trigger({ requestId: 'g5-trigger-1', nodeId: created.node.id, input: { value: 'changed' } }), /invalid_request|conflict/);
  desktopA = null; // Closing this view cannot cancel Hub or Satellite work.
  const { snapshot, item } = await activity(desktopB, 'g5-trigger-1');
  assert.equal(item.state, 'SUCCEEDED'); assert.equal(item.result.text, 'HELLO'); assert.equal(item.nodeId, created.node.id);
  assert.equal(snapshot.runs.find(run => run.id === 'g5-trigger-1').status, 'SUCCEEDED'); assert.equal(effects, 1);
  const duplicate = await desktopB.trigger({ requestId: 'g5-trigger-1', nodeId: created.node.id, input: { value: 'hello' } });
  assert.equal(duplicate.command.id, item.commandId); assert.equal(effects, 1);
  await client.stop(); executionStore.close(); client = undefined; executionStore = undefined;
  await app.shutdown(); app = await startDevelopmentServer(options);
  desktopB = desktop(app, token);
  const restored = await desktopB.snapshot();
  assert.equal(restored.activities[0].state, 'SUCCEEDED'); assert.equal(restored.edges[0].kind, 'pipe');
  assert.equal(restored.nodes.filter(node => node.kind === 'plugin').length, 2);
});
