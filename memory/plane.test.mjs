import assert from 'node:assert/strict';
import test from 'node:test';
import { openMemoryStore } from './store.mjs';
import { createMemoryPlane } from './plane.mjs';

const input = (requestId, content = '# memory') => ({ owner: 'author', requestId, targetId: 'memory-target', baseRevision: 1,
  content, worktree: '/srv/aylachi/coding-repos/memory-review', branch: 'review/memory' });

test('memory requires independent review and trusted promotion; stale base becomes explicit CONFLICT', async t => {
  const store = openMemoryStore(':memory:');
  const applied = [];
  const plane = createMemoryPlane({ store,
    promotionPolicy: async ({ proposal }) => ({ allow: proposal.branch === 'review/memory', ticket: `ticket-${proposal.id}` }),
    applyPromotion: async ({ proposal, ticket }) => { applied.push({ id: proposal.id, ticket }); return { revision: proposal.baseRevision + 1 }; } });
  t.after(() => store.close());
  const first = store.propose(input('one')).proposal;
  assert.throws(() => store.review(first.id, { expectedRevision: 1, reviewer: 'author', decision: 'APPROVED' }), /MEMORY_REVIEWER_REQUIRED/);
  const approved = store.review(first.id, { expectedRevision: 1, reviewer: 'reviewer', decision: 'APPROVED' });
  assert.equal(approved.state, 'APPROVED');
  const promoted = await plane.promote(first.id);
  assert.equal(promoted.proposal.state, 'PROMOTED');
  assert.equal(promoted.proposal.receipt.revision, 2);
  assert.equal(applied.length, 1);
  const second = store.propose(input('two', '# other')).proposal;
  store.review(second.id, { expectedRevision: 1, reviewer: 'reviewer', decision: 'APPROVED' });
  const conflict = await plane.promote(second.id);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.proposal.state, 'CONFLICT');
  assert.equal(applied.length, 1);
});

test('memory policy denial leaves the approved proposal retryable and performs no apply', async t => {
  const store = openMemoryStore(':memory:');
  t.after(() => store.close());
  let applies = 0;
  const plane = createMemoryPlane({ store, promotionPolicy: async () => ({ allow: false }), applyPromotion: async () => { applies++; return {}; } });
  const proposal = store.propose(input('denied')).proposal;
  store.review(proposal.id, { expectedRevision: 1, reviewer: 'reviewer', decision: 'APPROVED' });
  await assert.rejects(plane.promote(proposal.id), /MEMORY_PROMOTION_DENIED/);
  assert.equal(store.get(proposal.id).state, 'APPROVED');
  assert.equal(applies, 0);
});

test('memory without trusted policy or after uncertain apply cannot bypass promotion', async t => {
  const store = openMemoryStore(':memory:');
  t.after(() => store.close());
  const unavailable = createMemoryPlane({ store });
  const one = store.propose(input('one')).proposal;
  assert.throws(() => store.beginPromotion(one.id), /MEMORY_PROMOTION_NOT_APPROVED/);
  store.review(one.id, { expectedRevision: 1, reviewer: 'reviewer', decision: 'APPROVED' });
  await assert.rejects(unavailable.promote(one.id), /MEMORY_PROMOTION_UNAVAILABLE/);
  assert.equal(store.get(one.id).state, 'APPROVED');
  const denied = createMemoryPlane({ store, promotionPolicy: async () => ({ allow: true, ticket: 'ticket' }),
    applyPromotion: async () => { throw new Error('uncertain apply'); } });
  await assert.rejects(denied.promote(one.id), /uncertain apply/);
  assert.equal(store.get(one.id).state, 'PROMOTION_UNKNOWN');
  assert.equal(store.recoverPromotions(), 0);
});
