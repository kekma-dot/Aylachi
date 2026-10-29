import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { openSatelliteStore } from './store.mjs';
import { createSatellitePlane } from './plane.mjs';
import { createSatelliteServer } from './server.mjs';
import { createSatelliteClient } from './client.mjs';
import { openSatelliteExecutionStore } from './execution-store.mjs';
import { createBrowserExtensionConnector, createHeadlessConnector, createNativeConnector } from './connectors.mjs';

const secret = 'satellite-integration-secret-0123456789abcdef';
const registration = { id: 'sat-1', secret, tools: ['native.workspace.read', 'headless.http.fetch', 'browser.page.extract'],
  capabilities: ['workspace.read', 'http.fetch', 'browser.read'] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function terminal(plane, commandId, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const command = plane.get({ actor: 'owner', commandId });
    if (['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(command.state)) return command;
    await sleep(10);
  }
  throw new Error('TERMINAL_TIMEOUT');
}
async function fixtureServer(plane) {
  const server = createSatelliteServer({ plane, registrations: [registration] });
  const address = await server.listen();
  return { server, address, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('real authenticated HTTP Satellite executes native, headless and explicitly granted browser tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-satellite-http-'));
  await writeFile(join(root, 'note.txt'), 'workspace payload');
  const fixtureHttp = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('headless payload'); });
  fixtureHttp.listen(0, '127.0.0.1'); await once(fixtureHttp, 'listening');
  const store = openSatelliteStore(join(root, 'hub.sqlite')), plane = createSatellitePlane({ store, registrations: [registration] });
  const { server, baseUrl } = await fixtureServer(plane);
  const executionStore = openSatelliteExecutionStore(join(root, 'satellite.sqlite'));
  let extensionCalls = 0;
  const client = createSatelliteClient({ baseUrl, satelliteId: 'sat-1', secret, executionStore, pollIntervalMs: 5,
    connectors: [createNativeConnector({ root }), createHeadlessConnector({ allowedHosts: ['127.0.0.1'] }),
      createBrowserExtensionConnector({ bridge: { async extractText({ tabId, requestId }) {
        extensionCalls++;
        assert.equal(tabId, 'tab-allowed'); assert.ok(requestId.startsWith('connector-'));
        return { tabId, title: 'Granted page', text: 'browser payload' };
      } } })] });
  try {
    const unauthorized = await fetch(`${baseUrl}/v1/satellite/handshake`, { method: 'POST',
      headers: { authorization: ['Bear', 'er ', 'wrong-secret-wrong-secret-wrong-secret'].join(''), 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, satelliteId: 'sat-1', connectors: [] }) });
    assert.equal(unauthorized.status, 401);
    await client.start();
    const native = plane.invoke({ actor: 'owner', requestId: 'native-1', toolName: 'native.workspace.read', payload: { path: 'note.txt' } }).command;
    const headless = plane.invoke({ actor: 'owner', requestId: 'headless-1', toolName: 'headless.http.fetch',
      payload: { url: `http://127.0.0.1:${fixtureHttp.address().port}/fixture` } }).command;
    const browser = plane.invoke({ actor: 'owner', requestId: 'browser-1', toolName: 'browser.page.extract', payload: { tabId: 'tab-allowed' } }).command;
    assert.equal((await terminal(plane, native.id)).result.text, 'workspace payload');
    assert.equal((await terminal(plane, headless.id)).result.text, 'headless payload');
    assert.equal((await terminal(plane, browser.id)).result.text, 'browser payload');
    assert.equal(extensionCalls, 1);
    const catalog = plane.catalog();
    assert.equal(catalog.satellites[0].state, 'ONLINE');
    assert.deepEqual(catalog.connectors.map(connector => connector.kind).sort(), ['browser-extension', 'headless', 'native']);
    assert.equal(plane.events({ actor: 'owner' }).filter(event => event.type === 'command.terminal').length, 3);
  } finally {
    await client.stop(); executionStore.close(); await server.close(); store.close(); fixtureHttp.close();
    await once(fixtureHttp, 'close'); await rm(root, { recursive: true, force: true });
  }
});

test('remote listener is opt-in and restricted to Tailscale IPv4', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-bind-'));
  const store = openSatelliteStore(join(root, 'hub.sqlite'));
  const remote = createSatelliteServer({ plane: createSatellitePlane({ store, registrations: [registration] }), registrations: [registration] });
  await assert.rejects(async () => remote.listen(0, '100.64.0.1'), /REMOTE_BIND_DISABLED/);
  await assert.rejects(async () => remote.listen(0, '192.168.1.10', { allowRemote: true }), /REMOTE_BIND_REQUIRES_TAILSCALE_IPV4/);
  await remote.close(); store.close(); await rm(root, { recursive: true, force: true });
});

test('Hub completion outage retains Satellite result and never repeats a non-idempotent side effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-satellite-recovery-'));
  const effectTool = { name: 'test.effect.run', title: 'Effect', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    sideEffect: true, idempotent: false, requiresApproval: true, capabilities: ['test.effect'] };
  const effectRegistration = { id: 'sat-1', secret, tools: ['test.effect.run'], capabilities: ['test.effect'] };
  const store = openSatelliteStore(join(root, 'hub.sqlite')), plane = createSatellitePlane({ store, registrations: [effectRegistration] });
  let running = await fixtureServer(plane), executionStore = openSatelliteExecutionStore(join(root, 'satellite.sqlite'));
  let calls = 0, release, started;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  const client = createSatelliteClient({ baseUrl: running.baseUrl, satelliteId: 'sat-1', secret, executionStore, pollIntervalMs: 5,
    connectors: [{ manifest: { id: 'effect', kind: 'native', version: '1.0.0', tools: [effectTool] }, async execute() {
      calls++; started(); await gate; return { receipt: 'written-once' };
    } }] });
  try {
    await client.start();
    const { command } = plane.invoke({ actor: 'owner', requestId: 'effect-1', toolName: 'test.effect.run', payload: { path: 'result.txt' } });
    assert.equal(command.state, 'PENDING_APPROVAL');
    plane.approve({ actor: 'owner', commandId: command.id, expectedPayloadHash: command.payloadHash, action: 'approve' });
    await began;
    assert.equal(plane.get({ actor: 'owner', commandId: command.id }).state, 'RUNNING');
    await running.server.close();
    release();
    const pendingDeadline = Date.now() + 2000;
    while (!executionStore.pending().length && Date.now() < pendingDeadline) await sleep(10);
    assert.equal(executionStore.pending().length, 1);
    assert.equal(plane.get({ actor: 'owner', commandId: command.id }).state, 'RUNNING');
    running = await (async () => {
      const server = createSatelliteServer({ plane, registrations: [effectRegistration] });
      await server.listen(running.address.port);
      return { server, baseUrl: running.baseUrl, address: running.address };
    })();
    const completed = await terminal(plane, command.id);
    assert.equal(completed.state, 'SUCCEEDED');
    assert.equal(completed.result.receipt, 'written-once');
    assert.equal(calls, 1);
    for (let index = 0; index < 100 && executionStore.pending().length; index++) await sleep(10);
    assert.equal(executionStore.pending().length, 0);
  } finally {
    release(); await client.stop(); executionStore.close(); await running.server.close(); store.close();
    await rm(root, { recursive: true, force: true });
  }
});
