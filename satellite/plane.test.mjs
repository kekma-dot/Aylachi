import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSatelliteStore } from './store.mjs';
import { createSatellitePlane } from './plane.mjs';
import { payloadHash } from './protocol.mjs';

const tool = (patch = {}) => ({ name: 'test.effect.run', title: 'Test effect', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  sideEffect: true, idempotent: false, requiresApproval: true, capabilities: ['test.effect'], ...patch });
const manifest = (descriptor = tool()) => ({ protocolVersion: 1, satelliteId: 'sat-1', connectors: [{ id: 'native-test', kind: 'native', version: '1.0.0', tools: [descriptor] }] });
const registration = { id: 'sat-1', tools: ['test.effect.run'], capabilities: ['test.effect'] };
async function fixture(descriptor = tool(), clock = { value: 1000 }) {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-satellite-store-'));
  const store = openSatelliteStore(join(root, 'hub.sqlite'));
  const plane = createSatellitePlane({ store, registrations: [registration], now: () => clock.value, leaseMs: 100 });
  return { root, store, plane, clock, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}
const invoke = (plane, payload = { value: 1 }) => plane.invoke({ actor: 'owner', requestId: 'request-1', toolName: 'test.effect.run', payload });

test('manifest registration is owner-approved and protocol/capability mismatches fail before tool routing', async () => {
  const f = await fixture(); try {
    assert.throws(() => f.plane.handshake({ ...manifest(), protocolVersion: 2 }), /INVALID_MANIFEST/);
    assert.throws(() => f.plane.handshake({ ...manifest(), satelliteId: 'unknown' }), /SATELLITE_NOT_FOUND/);
    assert.throws(() => f.plane.handshake(manifest(tool({ capabilities: ['test.other'] }))), /CONNECTOR_NOT_APPROVED/);
    assert.throws(() => f.plane.handshake(manifest(tool({ name: 'test.other' }))), /CONNECTOR_NOT_APPROVED/);
    const session = f.plane.handshake(manifest());
    assert.equal(session.protocolOffset, 0);
    f.plane.heartbeat({ satelliteId: 'sat-1', sessionId: session.sessionId, connectors: [{ id: 'native-test', state: 'DEGRADED' }] });
    assert.equal(f.plane.catalog().connectors[0].health, 'DEGRADED');
    assert.throws(() => f.plane.invoke({ actor: 'owner', requestId: 'r', toolName: 'missing', payload: {} }), /NOT_FOUND/);
  } finally { await f.close(); }
});

test('approval precedes lease and exact payload/idempotent request/terminal result survive duplicate delivery', async () => {
  const f = await fixture(); try {
    const sessionId = f.plane.handshake(manifest()).sessionId;
    const reserved = invoke(f.plane);
    assert.equal(reserved.command.state, 'PENDING_APPROVAL');
    assert.deepEqual(f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands, []);
    assert.throws(() => f.plane.approve({ actor: 'owner', commandId: reserved.command.id, expectedPayloadHash: '0'.repeat(64), action: 'approve' }), /EFFECT_CONFLICT/);
    const approved = f.plane.approve({ actor: 'owner', commandId: reserved.command.id, expectedPayloadHash: reserved.command.payloadHash, action: 'approve' });
    assert.equal(approved.state, 'QUEUED');
    const [lease] = f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands;
    assert.equal(lease.fencingToken, 1);
    assert.equal(f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands[0].leaseId, lease.leaseId);
    f.plane.ack({ satelliteId: 'sat-1', sessionId, commandId: lease.commandId, leaseId: lease.leaseId, fencingToken: 1 });
    assert.equal(f.plane.get({ actor: 'owner', commandId: lease.commandId }).state, 'RUNNING');
    const completion = { satelliteId: 'sat-1', sessionId, commandId: lease.commandId, leaseId: lease.leaseId, fencingToken: 1,
      outcome: { state: 'SUCCEEDED', result: { receipt: 'one' } } };
    assert.equal(f.plane.complete(completion).duplicate, false);
    assert.equal(f.plane.complete(completion).duplicate, true);
    assert.equal(invoke(f.plane).duplicate, true);
    assert.throws(() => f.plane.invoke({ actor: 'owner', requestId: 'request-1', toolName: 'test.effect.run', payload: { value: 2 } }), /REQUEST_ID_CONFLICT/);
    const events = f.plane.events({ actor: 'owner' });
    assert.deepEqual(events.filter(event => event.type === 'command.terminal').map(event => event.payload.state), ['SUCCEEDED']);
    assert.equal(f.plane.events({ actor: 'other' }).length, 0);
  } finally { await f.close(); }
});

test('rejected approval never issues a lease', async () => {
  const f = await fixture(); try {
    const sessionId = f.plane.handshake(manifest()).sessionId;
    const { command } = invoke(f.plane);
    const rejected = f.plane.approve({ actor: 'owner', commandId: command.id, expectedPayloadHash: command.payloadHash, action: 'reject' });
    assert.equal(rejected.state, 'FAILED');
    assert.equal(rejected.reasonCode, 'APPROVAL_REJECTED');
    assert.deepEqual(f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands, []);
  } finally { await f.close(); }
});

test('non-idempotent expired effect becomes UNKNOWN and late authoritative result reconciles without a second lease', async () => {
  const f = await fixture(); try {
    const sessionId = f.plane.handshake(manifest()).sessionId;
    const { command } = invoke(f.plane);
    f.plane.approve({ actor: 'owner', commandId: command.id, expectedPayloadHash: command.payloadHash, action: 'approve' });
    const [lease] = f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands;
    f.clock.value += 101;
    assert.deepEqual(f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands, []);
    assert.equal(f.plane.get({ actor: 'owner', commandId: command.id }).state, 'UNKNOWN');
    const resolved = f.plane.complete({ satelliteId: 'sat-1', sessionId, commandId: command.id, leaseId: lease.leaseId,
      fencingToken: 1, outcome: { state: 'SUCCEEDED', result: { authoritative: true } } });
    assert.equal(resolved.command.state, 'SUCCEEDED');
    assert.deepEqual(f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands, []);
  } finally { await f.close(); }
});

test('idempotent retry receives a new fencing token and stale completion is rejected', async () => {
  const descriptor = tool({ sideEffect: false, idempotent: true, requiresApproval: false });
  const f = await fixture(descriptor); try {
    const sessionId = f.plane.handshake(manifest(descriptor)).sessionId;
    const { command } = invoke(f.plane);
    const [first] = f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands;
    f.clock.value += 101;
    const [second] = f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands;
    assert.equal(second.fencingToken, 2);
    assert.notEqual(second.leaseId, first.leaseId);
    assert.throws(() => f.plane.complete({ satelliteId: 'sat-1', sessionId, commandId: command.id, leaseId: first.leaseId,
      fencingToken: 1, outcome: { state: 'SUCCEEDED', result: {} } }), /LEASE_CONFLICT/);
  } finally { await f.close(); }
});

test('revocation fails queued work, marks dispatched work unknown and fences every later session operation', async () => {
  const descriptor = tool({ requiresApproval: false });
  const f = await fixture(descriptor); try {
    const sessionId = f.plane.handshake(manifest(descriptor)).sessionId;
    const { command } = invoke(f.plane);
    const [lease] = f.plane.poll({ satelliteId: 'sat-1', sessionId }).commands;
    f.plane.revoke({ satelliteId: 'sat-1' });
    assert.equal(f.plane.get({ actor: 'owner', commandId: command.id }).state, 'UNKNOWN');
    assert.throws(() => f.plane.handshake(manifest(descriptor)), /SATELLITE_REVOKED/);
    assert.throws(() => f.plane.poll({ satelliteId: 'sat-1', sessionId }), /SATELLITE_REVOKED/);
    assert.throws(() => f.plane.complete({ satelliteId: 'sat-1', sessionId, commandId: command.id, leaseId: lease.leaseId,
      fencingToken: 1, outcome: { state: 'SUCCEEDED', result: {} } }), /SATELLITE_REVOKED/);
    assert.equal(f.plane.catalog().satellites[0].state, 'REVOKED');
  } finally { await f.close(); }
});

test('SQLite journal retains command, payload hash and event offset across Hub reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-satellite-reopen-')), path = join(root, 'hub.sqlite');
  const store = openSatelliteStore(path), plane = createSatellitePlane({ store, registrations: [registration], now: () => 1000, leaseMs: 100 });
  plane.handshake(manifest());
  const { command } = invoke(plane, { durable: true });
  store.close();
  const reopened = openSatelliteStore(path), restored = createSatellitePlane({ store: reopened, registrations: [registration], now: () => 1001, leaseMs: 100 });
  try {
    const commandAfter = restored.get({ actor: 'owner', commandId: command.id });
    assert.equal(commandAfter.state, 'PENDING_APPROVAL');
    assert.equal(commandAfter.payloadHash, payloadHash({ durable: true }));
    assert.equal(restored.events({ actor: 'owner' }).at(-1).sequence, 1);
    assert.throws(() => restored.approve({ actor: 'other', commandId: command.id, expectedPayloadHash: command.payloadHash, action: 'approve' }), /NOT_FOUND/);
  } finally { reopened.close(); await rm(root, { recursive: true, force: true }); }
});
