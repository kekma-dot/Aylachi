import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDevelopmentServer } from './server.mjs';
import { createSatelliteClient } from '../satellite/client.mjs';
import { createNativeConnector } from '../satellite/connectors.mjs';
import { openSatelliteExecutionStore } from '../satellite/execution-store.mjs';

const secret = 'runtime-satellite-secret-0123456789abcdef';
const registration = { id: 'sat-runtime', secret, tools: ['native.workspace.read', 'test.effect.run'], capabilities: ['workspace.read', 'test.effect'] };
const effectTool = { name: 'test.effect.run', title: 'Effect', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  sideEffect: true, idempotent: false, requiresApproval: true, capabilities: ['test.effect'] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(app, token, path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, { method, redirect: 'error',
    headers: { authorization: ['Bear', 'er ', token].join(''), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function terminal(app, token, id) {
  for (let index = 0; index < 300; index++) {
    const result = await request(app, token, `/v1/modules/connectors/commands/${id}`);
    if (['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(result.body.command?.state)) return result.body.command;
    await sleep(10);
  }
  throw new Error('CONNECTOR_TERMINAL_TIMEOUT');
}

test('development application exposes durable connector control plane with approval and revocation', { timeout: 30_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'aylachi-runtime-satellite-')), stateRoot = join(scratch, 'state'), workspace = join(scratch, 'workspace');
  await mkdir(workspace); await writeFile(join(workspace, 'note.txt'), 'through real application');
  const options = { stateRoot, port: 0, satellite: { registrations: [registration], port: 0 } };
  let app = await startDevelopmentServer(options), executionStore, client, effects = 0;
  t.after(async () => {
    await client?.stop(); executionStore?.close();
    if (app) await app.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });
  assert.ok(app.satelliteAddress?.port > 0);
  assert.equal((await stat(join(stateRoot, 'satellite.sqlite'))).mode & 0o777, 0o600);
  const token = (await readFile(join(stateRoot, '.bearer'), 'utf8')).trim();
  assert.equal((await request(app, token, '/v1/modules/workspace/capabilities')).body.modules.connectors, true);
  executionStore = openSatelliteExecutionStore(join(scratch, 'client.sqlite'));
  client = createSatelliteClient({ baseUrl: `http://127.0.0.1:${app.satelliteAddress.port}`, satelliteId: 'sat-runtime', secret, executionStore, pollIntervalMs: 5,
    connectors: [createNativeConnector({ root: workspace }), { manifest: { id: 'effect', kind: 'native', version: '1.0.0', tools: [effectTool] },
      async execute({ payload }) { effects++; return { receipt: `once:${payload.value}` }; } }] });
  await client.start();

  const native = await request(app, token, '/v1/modules/connectors/tools/native.workspace.read', 'POST', { requestId: 'native-runtime', payload: { path: 'note.txt' } });
  assert.equal(native.status, 201);
  assert.equal((await terminal(app, token, native.body.command.id)).result.text, 'through real application');

  const pending = await request(app, token, '/v1/modules/connectors/tools/test.effect.run', 'POST', { requestId: 'effect-runtime', payload: { value: 7 } });
  assert.equal(pending.body.command.state, 'PENDING_APPROVAL');
  await sleep(50); assert.equal(effects, 0);
  const commandId = pending.body.command.id;
  assert.equal((await request(app, token, `/v1/modules/connectors/commands/${commandId}`, 'POST', { action: 'approve', expectedPayloadHash: '0'.repeat(64) })).status, 409);
  assert.equal((await request(app, token, `/v1/modules/connectors/commands/${commandId}`, 'POST', { action: 'approve', expectedPayloadHash: pending.body.command.payloadHash })).status, 200);
  assert.equal((await terminal(app, token, commandId)).result.receipt, 'once:7');
  assert.equal(effects, 1);
  const events = await request(app, token, '/v1/modules/connectors/events?after=0&limit=100');
  assert.equal(events.status, 200); assert.ok(events.body.events.length >= 6);
  assert.equal((await request(app, token, '/v1/modules/connectors/tools/missing.tool', 'POST', { requestId: 'missing', payload: {} })).status, 404);

  assert.equal((await request(app, token, '/v1/modules/connectors/satellites/sat-runtime', 'POST', { action: 'revoke' })).status, 200);
  assert.equal((await request(app, token, '/v1/modules/connectors')).body.satellites[0].state, 'REVOKED');
  await client.stop(); executionStore.close(); client = undefined; executionStore = undefined;
  assert.deepEqual(await app.shutdown(), { status: 'STOPPED' });

  app = await startDevelopmentServer(options);
  const restored = await request(app, token, `/v1/modules/connectors/commands/${commandId}`);
  assert.equal(restored.status, 200); assert.equal(restored.body.command.state, 'SUCCEEDED');
  assert.equal(restored.body.command.result.receipt, 'once:7');
  assert.equal((await request(app, token, '/v1/modules/connectors/events?after=0&limit=100')).body.events.length, events.body.events.length);
});
