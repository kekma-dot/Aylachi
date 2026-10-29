import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openToolEffectStore } from './effects.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aylachi-effects-'));
  const path = join(root, 'effects.sqlite');
  let store = openToolEffectStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { reserve: input => store.reserve({ actor: 'owner', requestId: 'request-1', parentCommandId: 'command-1', parentCardId: 'card-1', canvasId: 'canvas-1', toolName: 'delegate_task', text: 'child task', requiresApproval: false, now: 1, ...input }),
    get store() { return store; }, reopen: () => { store.close(); store = openToolEffectStore(path); return store; } };
}

test('approval binds the original payload and attempt; owner fencing is durable', t => {
  const f = fixture(t);
  const pending = f.reserve({ requiresApproval: true }).effect;
  assert.equal(pending.state, 'PENDING_APPROVAL');
  assert.throws(() => f.store.approve({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: '0'.repeat(64), now: 2 }), /EFFECT_CONFLICT/);
  assert.equal(f.store.get({ actor: 'owner', id: pending.id }).state, 'PENDING_APPROVAL');
  f.reopen();
  const approved = f.store.approve({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: pending.payloadHash, now: 3 });
  assert.equal(approved.state, 'APPROVED');
  const running = f.store.begin({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: pending.payloadHash, ownerId: 'owner-a', now: 4 });
  assert.equal(running.state, 'RUNNING');
  assert.throws(() => f.store.begin({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: pending.payloadHash, ownerId: 'owner-b', now: 5 }), /EFFECT_CONFLICT/);
  assert.throws(() => f.store.complete({ actor: 'owner', id: pending.id, attempt: 1, ownerId: 'owner-b', state: 'SUCCEEDED', receipt: { id: 'task-1' }, now: 5 }), /EFFECT_CONFLICT/);
  const receipt = { id: 'task-1', state: 'DISPATCHED' };
  assert.equal(f.store.complete({ actor: 'owner', id: pending.id, attempt: 1, ownerId: 'owner-a', state: 'SUCCEEDED', receipt, now: 6 }).state, 'SUCCEEDED');
  assert.deepEqual(f.store.complete({ actor: 'owner', id: pending.id, attempt: 1, ownerId: 'owner-a', state: 'SUCCEEDED', receipt, now: 7 }).receipt, receipt);
  assert.equal(f.reserve({ now: 8 }).duplicate, true);
});

test('restart turns RUNNING into UNKNOWN and only an authoritative receipt resolves it', t => {
  const f = fixture(t);
  const pending = f.reserve().effect;
  f.store.begin({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: pending.payloadHash, ownerId: 'owner-a', now: 2 });
  f.reopen();
  const recovered = f.store.recoverRunning({ now: 3 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'UNKNOWN');
  assert.equal(recovered[0].reasonCode, 'OWNER_RESTARTED');
  assert.throws(() => f.store.begin({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: pending.payloadHash, ownerId: 'owner-b', now: 4 }), /EFFECT_CONFLICT/);
  const receipt = { id: 'task-1', state: 'DISPATCHED' };
  const exact = f.store.reconcile({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: pending.payloadHash, receipt, now: 5 });
  assert.equal(exact.state, 'SUCCEEDED');
  assert.deepEqual(exact.receipt, receipt);
});

test('a known safe failure is terminal and cannot be silently converted to success', t => {
  const f = fixture(t);
  const pending = f.reserve().effect;
  f.store.begin({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: pending.payloadHash, ownerId: 'owner-a', now: 2 });
  const failed = f.store.complete({ actor: 'owner', id: pending.id, attempt: 1, ownerId: 'owner-a', state: 'FAILED', reasonCode: 'POLICY_DENIED', now: 3 });
  assert.equal(failed.state, 'FAILED');
  assert.throws(() => f.store.reconcile({ actor: 'owner', id: pending.id, attempt: 1, payloadHash: pending.payloadHash, receipt: { id: 'task-1' }, now: 4 }), /EFFECT_CONFLICT/);
});
