import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffController } from './handoff-controller.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'request-1';
const source = { cardId: 'source-card', kind: 'command', id: 'command-1' };
const targetCardId = 'target-card';
const hash = 'a'.repeat(64);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const record = (overrides = {}) => ({
  id, owner: 'alice', requestId, payloadHash: hash, state: 'pending', source: { ...source }, targetCardId,
  snapshot: { text: 'snapshot', sha256: hash }, createdAt: 100, acceptedAt: null, ...overrides,
});
const summary = value => ({ ...value, snapshot: { sha256: value.snapshot.sha256 } });
const api = (overrides = {}) => ({
  propose: async () => ({ record: record(), duplicate: false }),
  read: async id => ({ record: record({ id }) }),
  list: async () => ({ items: [] }),
  accept: async id => ({ record: record({ id, state: 'accepted', acceptedAt: 200 }), duplicate: false }),
  ...overrides,
});
const newId = count => () => `request-${++count.value}`;

test('proposal snapshots immutable payload once, returns UUID record, and never auto-accepts', async () => {
  const wait = deferred(), count = { value: 0 }, calls = [];
  const client = api({
    propose: input => { calls.push(input); return wait.promise; },
    accept: async () => { throw Error('must not auto-accept'); },
  });
  const controller = createHandoffController({ client, newRequestId: newId(count) });
  const formSource = { ...source };
  const pending = controller.propose({ source: formSource, targetCardId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requestId, 'request-1');
  assert.notEqual(calls[0].source, formSource);
  assert.equal(Object.isFrozen(controller.getSnapshot()), true);
  assert.equal(Object.isFrozen(controller.getSnapshot().pending), true);
  assert.equal(Object.isFrozen(controller.getSnapshot().pending.source), true);
  formSource.id = 'mutated-after-submit';
  assert.equal(calls[0].source.id, 'command-1');
  wait.resolve({ record: record(), duplicate: false });
  assert.equal(await pending, true);
  const state = controller.getSnapshot();
  assert.equal(state.selected.id, id); assert.deepEqual(state.items, [state.selected]);
  assert.equal(state.pending, null); assert.equal(state.uncertain, false); assert.equal(state.targetCardId, targetCardId);
  assert.equal(count.value, 1);
  controller.dispose();
});

test('known 409 is not uncertain and does not retain a retry request', async () => {
  const count = { value: 0 };
  const controller = createHandoffController({
    client: api({ propose: async () => { throw Object.assign(Error(), { status: 409, code: 'HTTP_ERROR' }); } }),
    newRequestId: newId(count),
  });
  assert.equal(await controller.propose({ source, targetCardId }), false);
  const state = controller.getSnapshot();
  assert.equal(state.error, 'CONFLICT'); assert.equal(state.pending, null); assert.equal(state.uncertain, false);
  assert.equal(count.value, 1);
  assert.equal(await controller.retrySameRequest(), false);
  controller.dispose();
});

test('lost proposal receipt has no automatic retry; explicit retry reuses identical request ID and payload', async () => {
  const count = { value: 0 }, calls = [];
  const client = api({ propose: async input => {
    calls.push({ ...input });
    if (calls.length === 1) throw Object.assign(Error(), { unknownOutcome: true, code: 'CONNECTION_FAILED' });
    return { record: record(), duplicate: true };
  } });
  const controller = createHandoffController({ client, newRequestId: newId(count) });
  assert.equal(await controller.propose({ source, targetCardId }), false);
  assert.equal(calls.length, 1);
  const pending = controller.getSnapshot().pending;
  assert.equal(pending.requestId, 'request-1'); assert.equal(controller.getSnapshot().uncertain, true);
  assert.equal(await controller.retrySameRequest(), true);
  assert.equal(calls.length, 2); assert.equal(count.value, 1);
  assert.equal(calls[1].requestId, calls[0].requestId);
  assert.deepEqual(calls[1].source, calls[0].source); assert.equal(calls[1].targetCardId, calls[0].targetCardId);
  assert.equal(controller.getSnapshot().uncertain, false); assert.equal(controller.getSnapshot().pending, null);
  controller.dispose();
});

test('read failures and known retry errors cannot clear uncertainty; unrelated or absent proposals never reconcile', async () => {
  const count = { value: 0 }, other = record({ id: otherId, requestId: 'unrelated-request' });
  let page = { items: [] }, reads = 0, posts = 0, retryFailure = true;
  const client = api({
    propose: async () => { posts++; throw Object.assign(Error(), { unknownOutcome: true, code: 'CONNECTION_FAILED' }); },
    list: async () => page,
    read: async noteId => {
      reads++;
      if (noteId === otherId) return { record: other };
      if (reads === 2) throw Object.assign(Error(), { status: 404, code: 'HTTP_ERROR' });
      return { record: record() };
    },
  });
  const controller = createHandoffController({ client, newRequestId: newId(count) });
  assert.equal(await controller.propose({ source, targetCardId }), false);
  assert.equal(posts, 1);
  page = { items: [summary(other)] };
  assert.equal(await controller.refresh(targetCardId), true);
  assert.equal(controller.getSnapshot().uncertain, true); assert.ok(controller.getSnapshot().pending);
  assert.equal(await controller.open(otherId), true);
  assert.equal(controller.getSnapshot().selected.id, otherId);
  assert.equal(controller.getSnapshot().uncertain, true); assert.ok(controller.getSnapshot().pending);

  page = { items: [] };
  assert.equal(await controller.reconcile(), false);
  assert.equal(controller.getSnapshot().uncertain, true); assert.ok(controller.getSnapshot().pending);
  page = { items: [summary(record())] };
  assert.equal(await controller.reconcile(), false); // list match, but read 404 is not proof of absence
  assert.equal(controller.getSnapshot().uncertain, true); assert.ok(controller.getSnapshot().pending);

  client.propose = async () => {
    posts++;
    if (retryFailure) throw Object.assign(Error(), { status: 409, code: 'HTTP_ERROR' });
    return { record: record(), duplicate: true };
  };
  assert.equal(await controller.retrySameRequest(), false);
  assert.equal(controller.getSnapshot().uncertain, true); assert.ok(controller.getSnapshot().pending);
  assert.equal(controller.getSnapshot().error, 'CONFLICT');
  retryFailure = false;
  assert.equal(await controller.retrySameRequest(), true);
  assert.equal(controller.getSnapshot().uncertain, false); assert.equal(controller.getSnapshot().pending, null);
  assert.equal(posts, 3); assert.equal(count.value, 1);
  controller.dispose();
});

test('positive proposal reconciliation requires request, source, target and readable record match', async () => {
  const count = { value: 0 };
  let page = { items: [summary(record({ requestId: 'someone-else' }))] }, reads = 0, posts = 0;
  const client = api({
    propose: async () => { posts++; throw Object.assign(Error(), { unknownOutcome: true, code: 'CONNECTION_FAILED' }); },
    list: async (_target, options) => { assert.equal(options.limit, 20); assert.equal(options.offset, 0); return page; },
    read: async noteId => { reads++; return { record: record({ id: noteId }) }; },
  });
  const controller = createHandoffController({ client, newRequestId: newId(count) });
  assert.equal(await controller.propose({ source, targetCardId }), false);
  assert.equal(await controller.reconcile(), false);
  assert.equal(reads, 0); assert.equal(controller.getSnapshot().uncertain, true);
  page = { items: [summary(record({ source: { ...source, id: 'different-source' } }))] };
  assert.equal(await controller.reconcile(), false);
  assert.equal(reads, 0); assert.equal(controller.getSnapshot().uncertain, true);
  page = { items: [summary(record())] };
  assert.equal(await controller.reconcile(), true);
  assert.equal(reads, 1); assert.equal(posts, 1); assert.equal(count.value, 1);
  assert.equal(controller.getSnapshot().selected.requestId, 'request-1');
  assert.equal(controller.getSnapshot().pending, null); assert.equal(controller.getSnapshot().uncertain, false);
  controller.dispose();
});

test('accept reconciliation keeps pending state uncertain, then resolves only on accepted read', async () => {
  const count = { value: 0 }, existing = record();
  let readCount = 0, acceptCalls = 0;
  const client = api({
    accept: async () => { acceptCalls++; throw Object.assign(Error(), { unknownOutcome: true, code: 'CONNECTION_FAILED' }); },
    read: async noteId => {
      readCount++;
      if (readCount === 1) throw Object.assign(Error(), { status: 404, code: 'HTTP_ERROR' });
      return { record: readCount === 2 ? existing : record({ id: noteId, state: 'accepted', acceptedAt: 200 }) };
    },
  });
  const controller = createHandoffController({ client, newRequestId: newId(count) });
  assert.equal(await controller.accept(id), false);
  assert.equal(acceptCalls, 1); assert.equal(count.value, 1);
  const savedPending = controller.getSnapshot().pending;
  assert.equal(savedPending.kind, 'accept'); assert.equal(savedPending.id, id);
  assert.equal(await controller.reconcile(), false);
  assert.equal(controller.getSnapshot().pending.requestId, savedPending.requestId);
  assert.equal(controller.getSnapshot().uncertain, true);
  assert.equal(await controller.reconcile(), false); // pending is not proof a late accept will not arrive
  assert.equal(controller.getSnapshot().uncertain, true); assert.ok(controller.getSnapshot().pending);
  assert.equal(await controller.reconcile(), true);
  assert.equal(controller.getSnapshot().selected.state, 'accepted');
  assert.equal(controller.getSnapshot().uncertain, false); assert.equal(controller.getSnapshot().pending, null);
  assert.equal(acceptCalls, 1); assert.equal(count.value, 1);
  controller.dispose();
});

test('disposal aborts reads only and ignores stale read/write completions', async () => {
  const readWait = deferred(), writeWait = deferred();
  let readSignal = null, writeSignal = null;
  let notifications = 0, count = { value: 0 };
  const client = api({
    list: (_target, { signal }) => { readSignal = signal; return readWait.promise; },
    propose: input => { writeSignal = input.signal; return writeWait.promise; },
  });
  const reading = createHandoffController({ client });
  reading.subscribe(() => notifications++);
  const readResult = reading.refresh(targetCardId);
  const readSnapshot = reading.getSnapshot();
  reading.dispose();
  assert.equal(readSignal.aborted, true);
  const disposedRead = reading.getSnapshot();
  readWait.resolve({ items: [summary(record())] });
  assert.equal(await readResult, false); assert.equal(reading.getSnapshot(), disposedRead);
  assert.equal(notifications, 1); assert.equal(readSnapshot.busy, true);

  const writing = createHandoffController({ client, newRequestId: newId(count) });
  let writeNotifications = 0; writing.subscribe(() => writeNotifications++);
  const writeResult = writing.propose({ source, targetCardId });
  const writeSnapshot = writing.getSnapshot();
  writing.dispose();
  assert.equal(writeSignal.aborted, false);
  const disposedWrite = writing.getSnapshot();
  writeWait.resolve({ record: record(), duplicate: false });
  assert.equal(await writeResult, false); assert.equal(writing.getSnapshot(), disposedWrite);
  assert.equal(writeNotifications, 2); assert.equal(writeSnapshot.busy, true);
});
