import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { openDelegationStore } from './store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const input = (extra = {}) => ({ actor: 'alice', requestId: 'request-1', parentCommandId: 'parent-command', parentCardId: 'parent-card', canvasId: 'canvas', text: 'delegate this safely', now: 10, ...extra });
const codeIs = code => error => error?.code === code;

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'aylachi-delegation-'));
  const path = join(dir, 'delegation.sqlite'), handles = [];
  const open = () => { const store = openDelegationStore(path); handles.push(store); return store; };
  try { await run({ path, open, store: open() }); }
  finally { for (const store of handles) store.close(); await rm(dir, { recursive: true, force: true }); }
}
function integrity(path) {
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
}
function transition(store, record, expectedState, nextState, now, result) {
  const value = { actor: record.actor, id: record.id, expectedState, nextState, now };
  if (arguments.length === 6) value.result = result;
  return store.transition(value);
}

test('two SQLite handles reserve once; retry preserves generated identity across reopen', async () => withStore(({ path, store, open }) => {
  const second = open(), first = store.reserve(input()), repeated = second.reserve(input({ now: 99 }));
  assert.equal(first.duplicate, false);
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.record, first.record);
  const r = first.record;
  assert.deepEqual(Object.keys(r).sort(), ['actor','cancelRequestId','canvasId','childCardId','childCommandId','childSessionId','createdAt','id','leaseId','parentCardId','parentCommandId','requestId','result','state','text','updatedAt'].sort());
  assert.equal(r.state, 'RESERVED'); assert.equal(r.result, null);
  assert.equal(r.createdAt, 10); assert.equal(r.updatedAt, 10);
  assert.match(r.id, UUID);
  assert.match(r.childCardId, new RegExp(`^child-${UUID.source.slice(1,-1)}$`));
  assert.match(r.childSessionId, new RegExp(`^session-${UUID.source.slice(1,-1)}$`));
  assert.match(r.leaseId, UUID);
  assert.match(r.childCommandId, new RegExp(`^delegate-${UUID.source.slice(1,-1)}$`));
  assert.match(r.cancelRequestId, new RegExp(`^cancel-${UUID.source.slice(1,-1)}$`));
  assert.equal(new Set([r.id,r.childCardId,r.childSessionId,r.leaseId,r.childCommandId,r.cancelRequestId]).size, 6);
  assert.deepEqual(second.get({ actor: 'alice', id: r.id }), r);
  assert.deepEqual(second.findRequest({ actor: 'alice', requestId: r.requestId }), r);
  assert.equal(second.get({ actor: 'bob', id: r.id }), null);
  assert.equal(second.findRequest({ actor: 'bob', requestId: r.requestId }), null);
  second.close();
  const reopened = open();
  assert.deepEqual(reopened.get({ actor: 'alice', id: r.id }), r);
  integrity(path);
}));

test('simultaneous same-key reservations from separate worker SQLite handles converge', async () => withStore(async ({ path, store }) => {
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    parentPort.once('message', async () => {
      try { const { openDelegationStore } = await import(workerData.moduleUrl);
        const store = openDelegationStore(workerData.path);
        const result = store.reserve(workerData.input);
        store.close(); parentPort.postMessage({ result });
      } catch (error) { parentPort.postMessage({ error: error.code || error.message }); }
      parentPort.close();
    }); parentPort.postMessage({ ready: true });`;
  const workers = [0, 1].map(() => {
    const worker = new Worker(source, { eval: true, workerData: { moduleUrl: new URL('./store.mjs', import.meta.url).href, path, input: input() } });
    let readyResolve, resultResolve, errorReject;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; errorReject = reject; });
    worker.on('message', message => {
      if (message.ready) readyResolve();
      else if (message.error) errorReject(new Error(message.error));
      else resultResolve(message.result);
    });
    worker.on('error', errorReject);
    return { worker, ready, result };
  });
  try {
    await Promise.all(workers.map(item => item.ready));
    for (const item of workers) item.worker.postMessage('reserve');
    const results = await Promise.all(workers.map(item => item.result));
    assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
    assert.deepEqual(results[0].record, results[1].record);
    assert.deepEqual(store.findRequest({ actor: 'alice', requestId: 'request-1' }), results[0].record);
  } finally {
    await Promise.all(workers.map(item => item.worker.terminate()));
  }
}));

test('request identity is immutable and conflicts do not replace or add records', async () => withStore(({ path, store }) => {
  const original = store.reserve(input()).record;
  const db = new DatabaseSync(path);
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM delegation_records').get().n;
  const before = count();
  for (const patch of [
    { parentCommandId: 'other-command' }, { parentCardId: 'other-card' }, { canvasId: 'other-canvas' }, { text: 'different text' },
  ]) assert.throws(() => store.reserve(input(patch)), codeIs('CONFLICT'));
  assert.deepEqual(store.reserve(input({ now: 500 })).record, original);
  assert.equal(store.reserve(input({ requestId: 'another-request' })).duplicate, false);
  assert.equal(count(), before + 1); // only the distinct request added a row
  db.close();
  assert.deepEqual(store.get({ actor: 'alice', id: original.id }), original);
  assert.equal(store.get({ actor: 'alice', id: 'missing' }), null);
  assert.equal(store.findRequest({ actor: 'alice', requestId: 'missing' }), null);
}));

test('CAS transitions allow only contract edges, exact replay, and immutable completion', async () => withStore(({ path, store, open }) => {
  const r = store.reserve(input()).record;
  assert.throws(() => transition(store, r, 'RESERVED', 'COMPLETED', 11, { status: 'cancelled' }), codeIs('INVALID_REQUEST'));
  assert.throws(() => store.transition({ actor: 'alice', id: 'missing', expectedState: 'RESERVED', nextState: 'DISPATCHED', now: 11 }), codeIs('NOT_FOUND'));
  assert.throws(() => store.transition({ actor: 'bob', id: r.id, expectedState: 'RESERVED', nextState: 'DISPATCHED', now: 11 }), codeIs('NOT_FOUND'));
  assert.throws(() => transition(store, r, 'RESERVED', 'DISPATCHED', 9), codeIs('INVALID_REQUEST'));
  const dispatched = transition(store, r, 'RESERVED', 'DISPATCHED', 11);
  assert.equal(dispatched.updatedAt, 11);
  assert.deepEqual(transition(store, r, 'RESERVED', 'DISPATCHED', 12), dispatched);
  assert.throws(() => transition(store, r, 'RESERVED', 'NEEDS_RECONCILIATION', 12), codeIs('CONFLICT'));
  assert.throws(() => transition(store, r, 'DISPATCHED', 'NEEDS_RECONCILIATION', 10), codeIs('INVALID_REQUEST'));
  transition(store, r, 'DISPATCHED', 'NEEDS_RECONCILIATION', 12);
  const completed = transition(store, r, 'NEEDS_RECONCILIATION', 'COMPLETED', 13, { status: 'ok', text: 'done' });
  assert.deepEqual(completed.result, { status: 'ok', text: 'done' });
  assert.deepEqual(transition(store, r, 'NEEDS_RECONCILIATION', 'COMPLETED', 14, { status: 'ok', text: 'done' }), completed);
  assert.throws(() => transition(store, r, 'NEEDS_RECONCILIATION', 'COMPLETED', 14, { status: 'ok', text: 'changed' }), codeIs('CONFLICT'));
  assert.throws(() => transition(store, r, 'NEEDS_RECONCILIATION', 'COMPLETED', 12, { status: 'ok', text: 'done' }), codeIs('INVALID_REQUEST'));
  assert.throws(() => transition(store, r, 'COMPLETED', 'NEEDS_RECONCILIATION', 15), codeIs('INVALID_REQUEST'));
  assert.equal(store.get({ actor: 'alice', id: r.id }).state, 'COMPLETED');

  const r2 = store.reserve(input({ requestId: 'request-2', now: 20 })).record;
  const n2 = transition(store, r2, 'RESERVED', 'NEEDS_RECONCILIATION', 20);
  const d2 = transition(store, n2, 'NEEDS_RECONCILIATION', 'DISPATCHED', 21);
  const c2 = transition(store, d2, 'DISPATCHED', 'COMPLETED', 22, { status: 'cancelled' });
  assert.deepEqual(c2.result, { status: 'cancelled' });
  const r3 = store.reserve(input({ requestId: 'request-3', now: 30 })).record;
  const d3 = transition(store, r3, 'RESERVED', 'DISPATCHED', 30);
  const c3 = transition(store, d3, 'DISPATCHED', 'COMPLETED', 31, { status: 'error', code: 'RUN_FAILED_2' });
  assert.deepEqual(c3.result, { status: 'error', code: 'RUN_FAILED_2' });
  const r4 = store.reserve(input({ requestId: 'request-4', now: 40 })).record;
  const d4 = transition(store, r4, 'RESERVED', 'DISPATCHED', 40);
  const exactText = 'é'.repeat(8192);
  const c4 = transition(store, d4, 'DISPATCHED', 'COMPLETED', 41, { status: 'ok', text: exactText });
  assert.equal(Buffer.byteLength(c4.result.text, 'utf8'), 16 * 1024);
  assert.throws(() => store.transition({ actor: 'alice', id: r.id, expectedState: 'RESERVED', nextState: 'DISPATCHED', now: 15 }), codeIs('CONFLICT'));
  const reopened = open();
  assert.deepEqual(reopened.get({ actor: 'alice', id: r.id }), completed);
  assert.deepEqual(reopened.get({ actor: 'alice', id: r2.id }), c2);
  assert.deepEqual(reopened.get({ actor: 'alice', id: r3.id }), c3);
  assert.deepEqual(reopened.get({ actor: 'alice', id: r4.id }), c4);
  integrity(path);
}));

test('validation rejects malformed objects/results and text beyond UTF-8 bound without writes', async () => withStore(({ store }) => {
  const accessor = Object.defineProperty(input(), 'text', { get() { throw Error('getter invoked'); }, enumerable: true });
  const polluted = input(); Object.defineProperty(polluted, '__proto__', { value: true, enumerable: true });
  let requestGetterCalled = false;
  const accessorInput = input(); Object.defineProperty(accessorInput, 'text', { get() { requestGetterCalled = true; throw Error('getter invoked'); }, enumerable: true });
  assert.throws(() => store.reserve(accessorInput), codeIs('INVALID_REQUEST'));
  assert.equal(requestGetterCalled, false);
  for (const invalid of [null, [], { ...input(), extra: 1 }, accessor, polluted, input({ actor: '' }), input({ requestId: 'bad/id' }), input({ parentCardId: 'x'.repeat(129) }), input({ text: '  \t\n' }), input({ text: 'x'.repeat(16 * 1024 + 1) }), input({ text: 'é'.repeat(8193) }), input({ now: -1 }), input({ now: 1.5 }), input({ now: Number.MAX_SAFE_INTEGER + 1 })]) {
    assert.throws(() => store.reserve(invalid));
  }
  assert.equal(store.findRequest({ actor: 'alice', requestId: 'request-1' }), null);
  const r = store.reserve(input({ text: 'x'.repeat(16 * 1024) })).record;
  const d = transition(store, r, 'RESERVED', 'DISPATCHED', 11);
  assert.throws(() => transition(store, d, 'DISPATCHED', 'COMPLETED', 12), codeIs('INVALID_REQUEST'));
  let resultGetterCalled = false;
  const badAccessor = {}; Object.defineProperty(badAccessor, 'status', { get() { resultGetterCalled = true; throw Error('status getter invoked'); }, enumerable: true });
  const invalidResults = [
    { status: 'ok', text: 'x'.repeat(16 * 1024 + 1) }, { status: 'ok', text: 1 }, { status: 'ok', text: 'x', extra: true },
    { status: 'cancelled', text: 'unexpected' }, { status: 'error', code: 'bad code' }, { status: 'error', code: 'A'.repeat(65) },
    badAccessor, Object.assign(Object.create({ inherited: true }), { status: 'cancelled' }),
  ];
  assert.throws(() => transition(store, d, 'DISPATCHED', 'COMPLETED', 12, badAccessor), codeIs('INVALID_REQUEST'));
  assert.equal(resultGetterCalled, false);
  for (const result of invalidResults.filter(value => value !== badAccessor)) assert.throws(() => transition(store, d, 'DISPATCHED', 'COMPLETED', 12, result));
  assert.deepEqual(store.get({ actor: 'alice', id: r.id }), d);
  assert.equal(store.findRequest({ actor: 'alice', requestId: 'request-1' }).state, 'DISPATCHED');
}));

test('close is idempotent and closed handles cannot access the database', async () => withStore(({ store }) => {
  store.close(); store.close();
  assert.throws(() => store.findRequest({ actor: 'alice', requestId: 'request-1' }), codeIs('INVALID_REQUEST'));
}));
