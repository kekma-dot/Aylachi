// delegation/coordinator.test.mjs — synthetic-only tests for CONTRACT v1.
// No real Hub/SQLite/SDK: in-memory fake store implements the frozen L03 API semantics,
// fake hubClient records every call. No network, no filesystem, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDelegationCoordinator } from './coordinator.mjs';

const PARENT = { actor: 'actor-1', parentCardId: 'card-parent', parentCommandId: 'cmd-parent', canvasId: 'canvas-1' };
const ALLOWED = {
  RESERVED: ['DISPATCHED', 'NEEDS_RECONCILIATION'],
  DISPATCHED: ['COMPLETED', 'NEEDS_RECONCILIATION'],
  NEEDS_RECONCILIATION: ['DISPATCHED', 'COMPLETED'],
  COMPLETED: [],
};

function createFakeStore() {
  const byId = new Map();
  const byRequest = new Map();
  let writes = 0;
  let n = 0;
  const clone = record => ({ ...record, result: record.result ? { ...record.result } : record.result });
  return {
    get writes() { return writes; },
    reserve({ actor, requestId, parentCommandId, parentCardId, canvasId, text, now }) {
      writes++;
      const prior = byRequest.get(JSON.stringify([actor, requestId]));
      if (prior) {
        const same = prior.parentCommandId === parentCommandId && prior.parentCardId === parentCardId &&
          prior.canvasId === canvasId && prior.text === text;
        if (!same) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
        return { record: clone(prior), duplicate: true };
      }
      n++;
      const record = {
        id: `task-${n}-${randomUUID()}`, actor, requestId, parentCommandId, parentCardId, canvasId, text,
        childCardId: `child-card-${randomUUID()}`, childSessionId: `child-session-${randomUUID()}`,
        leaseId: `lease-${randomUUID()}`, childCommandId: `child-cmd-${randomUUID()}`,
        cancelRequestId: `cancel-${randomUUID()}`, state: 'RESERVED', result: null,
        createdAt: now, updatedAt: now,
      };
      byId.set(record.id, record);
      byRequest.set(JSON.stringify([actor, requestId]), record);
      return { record: clone(record), duplicate: false };
    },
    get({ actor, id }) {
      const record = byId.get(id);
      return record && record.actor === actor ? clone(record) : null;
    },
    findRequest({ actor, requestId }) {
      const record = byRequest.get(JSON.stringify([actor, requestId]));
      return record && record.actor === actor ? clone(record) : null;
    },
    transition({ actor, id, expectedState, nextState, result, now }) {
      writes++;
      const record = byId.get(id);
      if (!record || record.actor !== actor) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
      if (record.state !== expectedState) throw Object.assign(new Error('CAS_CONFLICT'), { code: 'CAS_CONFLICT' });
      if (!ALLOWED[record.state].includes(nextState)) throw Object.assign(new Error('BAD_TRANSITION'), { code: 'BAD_TRANSITION' });
      record.state = nextState;
      if (nextState === 'COMPLETED') record.result = result ?? null;
      record.updatedAt = now;
      return clone(record);
    },
    close() {},
  };
}

function createFakeHub(behavior = {}) {
  const calls = { createCard: [], sendMessage: [], readCommand: [], cancelCommand: [] };
  const commands = new Map();
  return {
    calls,
    commands,
    async createCard(card, requestId, signal) {
      calls.createCard.push({ card, requestId });
      if (behavior.createCard) return behavior.createCard(card, requestId, signal);
      return { card, duplicate: false };
    },
    async sendMessage(cardId, text, requestId, signal) {
      calls.sendMessage.push({ cardId, text, requestId });
      if (behavior.sendMessage) return behavior.sendMessage(cardId, text, requestId, signal);
      commands.set(requestId, { id: requestId, state: 'RUNNING', result: null });
      return { command: commands.get(requestId), duplicate: false };
    },
    async readCommand(commandId, signal) {
      calls.readCommand.push(commandId);
      if (behavior.readCommand) return behavior.readCommand(commandId, signal);
      const command = commands.get(commandId);
      if (!command) throw Object.assign(new Error('not_found'), { status: 404 });
      return { command };
    },
    async cancelCommand(commandId, requestId, signal) {
      calls.cancelCommand.push({ commandId, requestId });
      if (behavior.cancelCommand) return behavior.cancelCommand(commandId, requestId, signal);
      return { command: { id: requestId, state: 'COMPLETED', result: { status: 'accepted', targetId: commandId } }, duplicate: false };
    },
  };
}

function fixture({ store = createFakeStore(), hub = createFakeHub(), approve, parent } = {}) {
  const approvals = [];
  const coordinator = createDelegationCoordinator({
    store, hubClient: hub,
    getParentContext: () => ({ ...(parent ?? PARENT) }),
    approve: input => { approvals.push(input); return approve ? approve(input) : true; },
    pollIntervalMs: 5, waitTimeoutMs: 200,
  });
  return { coordinator, store, hub, approvals };
}

test('constructor fails closed without trusted store/client/policy or bounded timings', () => {
  const store = createFakeStore();
  const hub = createFakeHub();
  const ok = { store, hubClient: hub, getParentContext: () => PARENT, approve: () => true, pollIntervalMs: 5, waitTimeoutMs: 50 };
  assert.ok(createDelegationCoordinator(ok));
  for (const bad of [
    { ...ok, store: undefined }, { ...ok, store: { reserve() {} } },
    { ...ok, hubClient: undefined }, { ...ok, hubClient: { createCard() {} } },
    { ...ok, getParentContext: undefined }, { ...ok, approve: undefined },
    { ...ok, pollIntervalMs: undefined }, { ...ok, waitTimeoutMs: 0 }, { ...ok, pollIntervalMs: -1 },
  ]) assert.throws(() => createDelegationCoordinator(bad), err => ['POLICY_UNAVAILABLE','INVALID_CONFIG'].includes(err.code));
  assert.equal(store.writes, 0);
  assert.equal(hub.calls.createCard.length + hub.calls.sendMessage.length, 0);
});

test('denied or non-exact-true policy: zero store writes and zero HTTP, approve runs before reserve', async () => {
  const { coordinator, store, hub, approvals } = fixture({ approve: () => 1 }); // truthy but not === true
  await assert.rejects(coordinator.delegate({ requestId: 'r1', text: 'task' }), err => err.code === 'POLICY_DENIED');
  assert.equal(store.writes, 0);
  assert.equal(hub.calls.createCard.length, 0);
  assert.equal(hub.calls.sendMessage.length, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action, 'delegate');
  const denied = fixture({ approve: () => false });
  await assert.rejects(denied.coordinator.delegate({ requestId: 'r1', text: 'task' }), err => err.code === 'POLICY_DENIED');
  assert.equal(denied.store.findRequest({ actor: PARENT.actor, requestId: 'r1' }), null);
});

test('input validation happens before parent/policy/store/HTTP', async () => {
  const { coordinator, store, hub, approvals } = fixture();
  for (const bad of [
    { requestId: 'r1' }, { requestId: 'r1', text: 'x', extra: 1 }, { text: 'x' },
    { requestId: 'bad/id', text: 'x' }, { requestId: 'r1', text: '' }, { requestId: 'r1', text: '  ' },
    { requestId: 'r1', text: 42 },
  ]) await assert.rejects(coordinator.delegate(bad), err => err.code === 'INVALID_INPUT');
  await assert.rejects(coordinator.wait('bad/id'), err => err.code === 'INVALID_INPUT');
  assert.equal(approvals.length, 0);
  assert.equal(store.writes, 0);
  assert.equal(hub.calls.sendMessage.length, 0);
});

test('delegate: child card and command POSTed exactly once with frozen generated IDs; receipt immutable', async () => {
  const { coordinator, hub } = fixture();
  const receipt = await coordinator.delegate({ requestId: 'r1', text: 'bounded task' });
  assert.equal(receipt.duplicate, false);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.record));
  const record = receipt.record;
  assert.equal(record.state, 'DISPATCHED');
  const ids = [record.id, record.childCardId, record.childSessionId, record.leaseId, record.childCommandId, record.cancelRequestId];
  assert.equal(new Set(ids).size, ids.length, 'task/card/session/lease/command/cancel IDs must be distinct');
  assert.equal(hub.calls.createCard.length, 1);
  assert.deepEqual(hub.calls.createCard[0].card, {
    id: record.childCardId, canvasId: record.canvasId, sessionId: record.childSessionId, title: 'Delegated task', x: 0, y: 0,
  });
  assert.equal(hub.calls.createCard[0].requestId, record.leaseId);
  assert.equal(hub.calls.sendMessage.length, 1);
  assert.deepEqual(hub.calls.sendMessage[0], { cardId: record.childCardId, text: 'bounded task', requestId: record.childCommandId });
});

test('sequential duplicate: no POST replay; concurrent duplicate shares one POST sequence', async () => {
  const { coordinator, hub } = fixture();
  const first = await coordinator.delegate({ requestId: 'r1', text: 'same payload' });
  const again = await coordinator.delegate({ requestId: 'r1', text: 'same payload' });
  assert.equal(again.duplicate, true);
  assert.equal(again.record.id, first.record.id);
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1);

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gated = fixture({
    hub: createFakeHub({ sendMessage: async (...args) => { await gate; return createFakeHub().sendMessage(...args); } }),
  });
  const a = gated.coordinator.delegate({ requestId: 'rc', text: 'concurrent' });
  const b = gated.coordinator.delegate({ requestId: 'rc', text: 'concurrent' });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.duplicate, false);
  assert.equal(rb.duplicate, true);
  assert.equal(ra.record.id, rb.record.id);
  assert.equal(gated.hub.calls.sendMessage.length, 1, 'concurrent duplicates must not run two POSTs');
});

test('changed payload for same requestId conflicts without HTTP, in-flight and after settle', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { coordinator, hub, store } = fixture({
    hub: createFakeHub({ sendMessage: async (...args) => { await gate; return createFakeHub().sendMessage(...args); } }),
  });
  const pending = coordinator.delegate({ requestId: 'r1', text: 'original' });
  await assert.rejects(coordinator.delegate({ requestId: 'r1', text: 'changed' }), err => err.code === 'CONFLICT');
  release();
  await pending;
  await assert.rejects(coordinator.delegate({ requestId: 'r1', text: 'changed' }), err => err.code === 'CONFLICT');
  assert.equal(hub.calls.sendMessage.length, 1);
  assert.equal(store.findRequest({ actor: PARENT.actor, requestId: 'r1' }).text, 'original');
});

test('lost send receipt: delegate rejects with record retained, NEEDS_RECONCILIATION, IDs/text preserved', async () => {
  const { coordinator, store, hub } = fixture({
    hub: createFakeHub({ sendMessage: async () => { throw new Error('committed response lost'); } }),
  });
  const error = await coordinator.delegate({ requestId: 'lost', text: 'one child task' }).then(() => null, caught => caught);
  assert.equal(error.code, 'DELEGATE_OUTCOME_UNKNOWN');
  assert.ok(error.record, 'error must retain the task record');
  const stored = store.findRequest({ actor: PARENT.actor, requestId: 'lost' });
  assert.equal(stored.state, 'NEEDS_RECONCILIATION');
  assert.equal(stored.text, 'one child task');
  assert.equal(stored.childCommandId, error.record.childCommandId);
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1);
});

test('reconcile maps Hub state read-only; completed terminal never downgraded; missing read stays unknown', async () => {
  const { coordinator, store, hub } = fixture();
  const { record } = await coordinator.delegate({ requestId: 'r1', text: 'task' });
  hub.commands.get(record.childCommandId).state = 'NEEDS_RECONCILIATION';
  const uncertain = await coordinator.reconcile(record.id);
  assert.equal(uncertain.state, 'NEEDS_RECONCILIATION');
  hub.commands.get(record.childCommandId).state = 'RUNNING';
  assert.equal((await coordinator.reconcile(record.id)).state, 'DISPATCHED');
  hub.commands.get(record.childCommandId).state = 'COMPLETED';
  hub.commands.get(record.childCommandId).result = { status: 'ok', text: 'child answer' };
  const done = await coordinator.reconcile(record.id);
  assert.equal(done.state, 'COMPLETED');
  assert.deepEqual(done.result, { status: 'ok', text: 'child answer' });
  // Terminal is immutable: even a hostile later RUNNING read must not downgrade, and is not consulted.
  hub.commands.get(record.childCommandId).state = 'RUNNING';
  const readsBefore = hub.calls.readCommand.length;
  assert.equal((await coordinator.reconcile(record.id)).state, 'COMPLETED');
  assert.equal(hub.calls.readCommand.length, readsBefore);

  const lost = fixture({ hub: createFakeHub({ sendMessage: async () => { throw new Error('lost'); } }) });
  await assert.rejects(lost.coordinator.delegate({ requestId: 'r2', text: 'x' }));
  const writesBefore = lost.store.writes;
  const unknown = await lost.coordinator.reconcile(lost.store.findRequest({ actor: PARENT.actor, requestId: 'r2' }).id);
  assert.equal(unknown.state, 'NEEDS_RECONCILIATION');
  assert.equal(lost.store.writes, writesBefore, 'missing read must not mutate');
  assert.equal(lost.hub.calls.createCard.length, 1, 'reconcile is read-only: no replay');
});

test('wait polls read-only to terminal; timeout and abort retain record and never replay/cancel', async () => {
  const { coordinator, hub } = fixture();
  const { record } = await coordinator.delegate({ requestId: 'r1', text: 'task' });
  let reads = 0;
  hub.commands.get(record.childCommandId).state = 'RUNNING';
  const waiting = coordinator.wait(record.id);
  const done = await (async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    hub.commands.get(record.childCommandId).state = 'COMPLETED';
    hub.commands.get(record.childCommandId).result = { status: 'ok', text: 'fixture complete' };
    return waiting;
  })();
  assert.equal(done.state, 'COMPLETED');
  assert.equal(done.result.text, 'fixture complete');

  const stuck = fixture();
  const { record: stuckRecord } = await stuck.coordinator.delegate({ requestId: 'r2', text: 'task' });
  const timeoutError = await stuck.coordinator.wait(stuckRecord.id).then(() => null, caught => caught);
  assert.equal(timeoutError.code, 'WAIT_TIMEOUT');
  assert.equal(timeoutError.record.id, stuckRecord.id);
  assert.equal(stuck.hub.calls.sendMessage.length, 1, 'timeout must not replay');
  assert.equal(stuck.hub.calls.cancelCommand.length, 0, 'timeout must not cancel');

  const controller = new AbortController();
  const abortedFixture = fixture();
  const { record: abortRecord } = await abortedFixture.coordinator.delegate({ requestId: 'r3', text: 'task' });
  const aborting = abortedFixture.coordinator.wait(abortRecord.id, { signal: controller.signal });
  setTimeout(() => controller.abort(), 15);
  const abortError = await aborting.then(() => null, caught => caught);
  assert.equal(abortError.code, 'ABORTED');
  assert.equal(abortError.record.id, abortRecord.id);
  assert.equal(abortedFixture.hub.calls.cancelCommand.length, 0, 'abort must not silently cancel the child');
  assert.equal(abortedFixture.hub.calls.sendMessage.length, 1);
  assert.ok(reads >= 0);
});

test('cancel is an explicit request with stable cancelRequestId; receipt never claims task cancelled', async () => {
  const { coordinator, hub, store } = fixture();
  const { record } = await coordinator.delegate({ requestId: 'r1', text: 'task' });
  const first = await coordinator.cancel(record.id);
  assert.equal(first.cancelRequested, true);
  assert.equal(hub.calls.cancelCommand.length, 1);
  assert.deepEqual(hub.calls.cancelCommand[0], { commandId: record.childCommandId, requestId: record.cancelRequestId });
  assert.notEqual(first.record.state, 'COMPLETED', 'accepted cancel receipt is not a cancelled task');
  assert.equal(store.get({ actor: PARENT.actor, id: record.id }).state, 'DISPATCHED');
  // Later observation, not the receipt, moves the task to a terminal cancelled result.
  hub.commands.get(record.childCommandId).state = 'COMPLETED';
  hub.commands.get(record.childCommandId).result = { status: 'cancelled' };
  const observed = await coordinator.reconcile(record.id);
  assert.equal(observed.state, 'COMPLETED');
  assert.deepEqual(observed.result, { status: 'cancelled' });
  // Terminal task: cancel is a no-op without new HTTP.
  assert.equal((await coordinator.cancel(record.id)).cancelRequested, false);
  assert.equal(hub.calls.cancelCommand.length, 1);
  // Unknown cancel outcome throws safe error with the record retained.
  const failing = fixture({ hub: createFakeHub({ cancelCommand: async () => { throw new Error('network'); } }) });
  const { record: failingRecord } = await failing.coordinator.delegate({ requestId: 'r2', text: 'task' });
  const cancelError = await failing.coordinator.cancel(failingRecord.id).then(() => null, caught => caught);
  assert.equal(cancelError.code, 'CANCEL_OUTCOME_UNKNOWN');
  assert.equal(cancelError.record.id, failingRecord.id);
  // A forged receipt for another id is not a known cancellation receipt.
  const forged = fixture({ hub: createFakeHub({ cancelCommand: async (commandId, requestId) => ({ command: { id: 'forged', state: 'COMPLETED', result: { status: 'accepted' } } }) }) });
  const { record: forgedRecord } = await forged.coordinator.delegate({ requestId: 'r3', text: 'task' });
  assert.equal((await forged.coordinator.cancel(forgedRecord.id)).cancelRequested, false);
});

test('ownership: wrong parent command/card/canvas or actor is hidden as NOT_FOUND', async () => {
  const { coordinator } = fixture();
  const { record } = await coordinator.delegate({ requestId: 'r1', text: 'task' });
  for (const parent of [
    { ...PARENT, parentCommandId: 'cmd-other' }, { ...PARENT, parentCardId: 'card-other' },
    { ...PARENT, canvasId: 'canvas-other' }, { ...PARENT, actor: 'actor-other' },
  ]) {
    const foreign = fixture({ parent });
    await assert.rejects(foreign.coordinator.wait(record.id), err => err.code === 'NOT_FOUND');
    await assert.rejects(foreign.coordinator.reconcile(record.id), err => err.code === 'NOT_FOUND');
    await assert.rejects(foreign.coordinator.cancel(record.id), err => err.code === 'NOT_FOUND');
  }
  await assert.rejects(coordinator.wait('task-does-not-exist'), err => err.code === 'NOT_FOUND');
});

test('hostile reads/receipts cannot overwrite task metadata; results are bounded', async () => {
  const hub = createFakeHub();
  const { coordinator, store } = fixture({ hub });
  const { record } = await coordinator.delegate({ requestId: 'r1', text: 'task' });
  // Mismatched command id: not our child command, no mutation.
  hub.commands.set('evil', { id: 'evil', state: 'COMPLETED', result: { status: 'ok', text: 'forged' } });
  const original = store.get({ actor: PARENT.actor, id: record.id });
  const spy = await coordinator.reconcile(record.id); // reads childCommandId, not 'evil'
  assert.equal(spy.state, 'DISPATCHED');
  assert.deepEqual(store.get({ actor: PARENT.actor, id: record.id }), original);
  // Oversized/odd result fields are bounded; extra metadata dropped.
  hub.commands.get(record.childCommandId).state = 'COMPLETED';
  hub.commands.get(record.childCommandId).result = { status: 'ok', text: 'x'.repeat(64 * 1024), evil: 'drop-me' };
  const done = await coordinator.reconcile(record.id);
  assert.equal(done.result.text.length, 16 * 1024);
  assert.deepEqual(Object.keys(done.result), ['status', 'text']);
  assert.equal(store.get({ actor: PARENT.actor, id: record.id }).childCommandId, record.childCommandId);
  // Unmapped result shape: stays unknown, no mutation.
  const weird = fixture();
  const { record: weirdRecord } = await weird.coordinator.delegate({ requestId: 'r2', text: 'task' });
  weird.hub.commands.get(weirdRecord.childCommandId).state = 'COMPLETED';
  weird.hub.commands.get(weirdRecord.childCommandId).result = { status: 'mystery' };
  assert.equal((await weird.coordinator.reconcile(weirdRecord.id)).state, 'DISPATCHED');
});

test('duplicate after lost receipt reconciles by read only, preserving identity (no replay)', async () => {
  const hub = createFakeHub({ sendMessage: async () => { throw new Error('lost'); } });
  const { coordinator, store } = fixture({ hub });
  await assert.rejects(coordinator.delegate({ requestId: 'lost', text: 'task' }));
  const uncertain = store.findRequest({ actor: PARENT.actor, requestId: 'lost' });
  // Hub actually committed the command before the receipt was lost.
  hub.commands.set(uncertain.childCommandId, { id: uncertain.childCommandId, state: 'COMPLETED', result: { status: 'ok', text: 'retained on server' } });
  const again = await coordinator.delegate({ requestId: 'lost', text: 'task' });
  assert.equal(again.duplicate, true);
  assert.equal(again.record.id, uncertain.id);
  assert.equal(again.record.state, 'COMPLETED');
  assert.equal(again.record.result.text, 'retained on server');
  assert.equal(hub.calls.createCard.length, 1);
  assert.equal(hub.calls.sendMessage.length, 1, 'no auto repeat create/send after restart/unknown outcome');
});

test('F1: in-flight key is tuple-safe and never shares another parent scope\'s pending task', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gatedHub = createFakeHub({ sendMessage: async (...args) => { await gate; return createFakeHub().sendMessage(...args); } });
  // Same coordinator, parent context switches mid-flight: same actor+requestId+text but
  // a DIFFERENT parentCommandId must conflict, never share the foreign pending record.
  let current = PARENT;
  const { coordinator, store, hub, approvals } = fixture({ hub: gatedHub });
  const foreign = createDelegationCoordinator({
    store, hubClient: hub, getParentContext: () => ({ ...current }),
    approve: input => { approvals.push(input); return true; }, pollIntervalMs: 5, waitTimeoutMs: 200,
  });
  const first = coordinator.delegate({ requestId: 'r1', text: 'same text' });
  current = { ...PARENT, parentCommandId: 'cmd-other' };
  await assert.rejects(foreign.delegate({ requestId: 'r1', text: 'same text' }), err => err.code === 'CONFLICT');
  current = PARENT;
  release();
  const done = await first;
  assert.equal(done.record.parentCommandId, 'cmd-parent');
  assert.equal(hub.calls.sendMessage.length, 1);
  // Colon collision: actor='a:b',request='c' vs actor='a',request='b:c' are distinct tasks.
  const colonHub = createFakeHub();
  const colonStore = createFakeStore();
  let colonParent = { ...PARENT, actor: 'a:b' };
  const colon = createDelegationCoordinator({
    store: colonStore, hubClient: colonHub, getParentContext: () => ({ ...colonParent }),
    approve: () => true, pollIntervalMs: 5, waitTimeoutMs: 50,
  });
  const one = await colon.delegate({ requestId: 'c', text: 'task one' });
  colonParent = { ...PARENT, actor: 'a' };
  const two = await colon.delegate({ requestId: 'b:c', text: 'task two' });
  assert.notEqual(one.record.id, two.record.id);
  assert.equal(one.record.actor, 'a:b');
  assert.equal(two.record.actor, 'a');
  assert.equal(colonHub.calls.sendMessage.length, 2, 'distinct tasks must dispatch separately');
});

test('F2: persisted RESERVED with child already COMPLETED reconciles to terminal without POST', async () => {
  const { coordinator, store, hub } = fixture();
  // Simulate a crash after reserve but before any POST: RESERVED persisted, no in-memory state.
  const { record } = store.reserve({
    actor: PARENT.actor, requestId: 'crash', parentCommandId: PARENT.parentCommandId,
    parentCardId: PARENT.parentCardId, canvasId: PARENT.canvasId, text: 'crash window', now: 1,
  });
  hub.commands.set(record.childCommandId, { id: record.childCommandId, state: 'COMPLETED', result: { status: 'ok', text: 'finished while down' } });
  const reconciled = await coordinator.reconcile(record.id);
  assert.equal(reconciled.state, 'COMPLETED');
  assert.equal(reconciled.result.text, 'finished while down');
  assert.equal(hub.calls.createCard.length + hub.calls.sendMessage.length, 0, 'reconcile is read-only');
  // Same path via duplicate delegate: RESERVED duplicate must also reach terminal, read-only.
  const again = await coordinator.delegate({ requestId: 'crash', text: 'crash window' });
  assert.equal(again.duplicate, true);
  assert.equal(again.record.state, 'COMPLETED');
  assert.equal(hub.calls.sendMessage.length, 0);
});

test('F3: completed results are bounded by UTF-8 bytes without split codepoints; missing text stays unknown', async () => {
  const { coordinator, hub } = fixture();
  const { record } = await coordinator.delegate({ requestId: 'r1', text: 'unicode' });
  // 9000 two-byte codepoints = 18000 UTF-8 bytes > 16KiB store limit.
  hub.commands.get(record.childCommandId).state = 'COMPLETED';
  hub.commands.get(record.childCommandId).result = { status: 'ok', text: 'é'.repeat(9000) };
  const done = await coordinator.reconcile(record.id);
  assert.equal(done.state, 'COMPLETED');
  assert.ok(Buffer.byteLength(done.result.text, 'utf8') <= 16 * 1024);
  assert.ok(done.result.text.length > 0);
  assert.equal(done.result.text, 'é'.repeat(done.result.text.length), 'no split or replaced codepoints');
  assert.equal(Buffer.byteLength(done.result.text, 'utf8') + 2 > 16 * 1024, true, 'bound is tight at the codepoint boundary');
  // Missing/non-string ok text must NOT become a fabricated empty success.
  const odd = fixture();
  const { record: oddRecord } = await odd.coordinator.delegate({ requestId: 'r2', text: 'task' });
  odd.hub.commands.get(oddRecord.childCommandId).state = 'COMPLETED';
  odd.hub.commands.get(oddRecord.childCommandId).result = { status: 'ok' };
  assert.equal((await odd.coordinator.reconcile(oddRecord.id)).state, 'DISPATCHED');
});

test('cancel surfaces a static safe error without raw client cause leakage', async () => {
  const leaky = createFakeHub({ cancelCommand: async () => { throw new Error('fetch http://127.0.0.1:9 secret-token ABORTED_xyz failed'); } });
  const { coordinator } = fixture({ hub: leaky });
  const { record } = await coordinator.delegate({ requestId: 'r1', text: 'task' });
  const error = await coordinator.cancel(record.id).then(() => null, caught => caught);
  assert.equal(error.code, 'CANCEL_OUTCOME_UNKNOWN');
  assert.equal(error.message, 'cancel request outcome unknown');
  assert.ok(!JSON.stringify(error).includes('secret-token'), 'raw client cause must not leak');
  assert.ok(Object.isFrozen(error.record));
});

test('non-plain or accessor-bearing input/context fails before approve/store/HTTP', async () => {
  const { coordinator, store, hub, approvals } = fixture();
  const withGetter = { requestId: 'r1', get text() { return 'evil'; } };
  await assert.rejects(coordinator.delegate(withGetter), err => err.code === 'INVALID_INPUT');
  class Boxed { constructor() { this.requestId = 'r1'; this.text = 'x'; } }
  await assert.rejects(coordinator.delegate(new Boxed()), err => err.code === 'INVALID_INPUT');
  const boxedContext = fixture({ parent: { actor: new String('actor-1'), parentCardId: 'card-parent', parentCommandId: 'cmd-parent', canvasId: 'canvas-1' } });
  await assert.rejects(boxedContext.coordinator.delegate({ requestId: 'r1', text: 'x' }), err => err.code === 'PARENT_CONTEXT_INVALID');
  assert.equal(approvals.length, 0);
  assert.equal(boxedContext.approvals.length, 0, 'no policy call for invalid context');
  assert.equal(store.writes, 0);
  assert.equal(hub.calls.sendMessage.length, 0);
});
