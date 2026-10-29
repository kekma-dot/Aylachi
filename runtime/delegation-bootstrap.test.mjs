import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { readDelegationBootstrap } from './pi-worker.mjs';

const url = 'http://127.0.0.1:46231';
const bearer = 'a'.repeat(64);
const env = { AYLACHI_DEV_DELEGATION: '1' };
const frame = () => ({
  type: 'delegation_bootstrap',
  connection: { baseUrl: url, bearer },
  parentSessionIds: ['parent-a', 'parent_b'],
});
function channel() {
  const value = new EventEmitter();
  value.connected = true;
  return value;
}
function safeFailure(error) {
  assert.equal(error.message, 'HOST_START_FAILED');
  assert.equal(error.code, 'HOST_START_FAILED');
  assert.equal(error.message.includes(bearer), false);
  assert.equal(error.message.includes(url), false);
  return true;
}
async function rejectFrame(message, options) {
  const ipc = channel();
  const pending = readDelegationBootstrap(ipc, env, options);
  ipc.emit('message', message);
  await assert.rejects(pending, safeFailure);
  assert.equal(ipc.listenerCount('message'), 0);
  assert.equal(ipc.listenerCount('error'), 0);
  assert.equal(ipc.listenerCount('disconnect'), 0);
}

test('disabled environment returns synchronously without touching IPC listeners', () => {
  const ipc = channel();
  ipc.connected = false;
  assert.equal(readDelegationBootstrap(ipc, {}), undefined);
  assert.equal(ipc.listenerCount('message'), 0);
  assert.equal(ipc.listenerCount('error'), 0);
  assert.equal(ipc.listenerCount('disconnect'), 0);
});

test('any defined non-opt-in value fails closed before reading IPC', () => {
  const ipc = channel();
  for (const value of ['', '0', 'true', '01']) {
    assert.throws(() => readDelegationBootstrap(ipc, { AYLACHI_DEV_DELEGATION: value }), safeFailure);
  }
  assert.equal(ipc.listenerCount('message'), 0);
  assert.equal(ipc.listenerCount('error'), 0);
  assert.equal(ipc.listenerCount('disconnect'), 0);
});

test('valid first frame becomes a detached frozen snapshot and listeners are cleaned', async () => {
  const ipc = channel();
  const original = frame();
  const pending = readDelegationBootstrap(ipc, env);
  ipc.emit('message', original);
  const snapshot = await pending;
  assert.deepEqual(snapshot, original);
  assert.notEqual(snapshot, original);
  assert.notEqual(snapshot.connection, original.connection);
  assert.notEqual(snapshot.parentSessionIds, original.parentSessionIds);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.connection), true);
  assert.equal(Object.isFrozen(snapshot.parentSessionIds), true);
  original.connection.bearer = 'b'.repeat(64);
  original.parentSessionIds[0] = 'changed';
  assert.equal(snapshot.connection.bearer, bearer);
  assert.equal(snapshot.parentSessionIds[0], 'parent-a');
  assert.equal(ipc.listenerCount('message'), 0);
  assert.equal(ipc.listenerCount('error'), 0);
  assert.equal(ipc.listenerCount('disconnect'), 0);
});

test('extra keys, symbols, getters and accessor array entries reject without invoking getters', async () => {
  const extra = frame();
  extra.unexpected = 'x';
  const symbol = frame();
  symbol[Symbol('extra')] = 'x';
  let getters = 0;
  const topAccessor = frame();
  Object.defineProperty(topAccessor, 'type', { enumerable: true, get() { getters++; return 'delegation_bootstrap'; } });
  const connectionAccessor = frame();
  Object.defineProperty(connectionAccessor.connection, 'bearer', { enumerable: true, get() { getters++; return bearer; } });
  const arrayAccessor = frame();
  Object.defineProperty(arrayAccessor.parentSessionIds, '0', { enumerable: true, configurable: true, get() { getters++; return 'parent-a'; } });
  for (const bad of [extra, symbol, topAccessor, connectionAccessor, arrayAccessor]) await rejectFrame(bad);
  assert.equal(getters, 0);
});

test('invalid URL, bearer, IDs, duplicates, count, and oversized frame reject safely', async () => {
  const cases = [];
  cases.push({ ...frame(), connection: { baseUrl: 'http://localhost:46231', bearer } });
  cases.push({ ...frame(), connection: { baseUrl: 'http://127.0.0.2:46231', bearer } });
  cases.push({ ...frame(), connection: { baseUrl: `${url}/path`, bearer } });
  cases.push({ ...frame(), connection: { baseUrl: url, bearer: 'A'.repeat(64) } });
  cases.push({ ...frame(), parentSessionIds: ['parent-a', 'parent-a'] });
  cases.push({ ...frame(), parentSessionIds: ['bad session'] });
  cases.push({ ...frame(), parentSessionIds: ['a', 'b', 'c', 'd'] });
  cases.push({ ...frame(), connection: { baseUrl: `${url}/${'x'.repeat(4100)}`, bearer } });
  for (const bad of cases) await rejectFrame(bad);
});

test('timeout, channel error, and disconnect reject with static errors and remove listeners', async () => {
  const timed = channel();
  await assert.rejects(readDelegationBootstrap(timed, env, { timeoutMs: 10 }), safeFailure);
  assert.equal(timed.listenerCount('message'), 0);
  assert.equal(timed.listenerCount('error'), 0);
  assert.equal(timed.listenerCount('disconnect'), 0);

  for (const event of ['error', 'disconnect']) {
    const ipc = channel();
    const pending = readDelegationBootstrap(ipc, env, { timeoutMs: 1000 });
    ipc.emit(event, new Error(`raw ${bearer} ${url}`));
    await assert.rejects(pending, safeFailure);
    assert.equal(ipc.listenerCount('message'), 0);
    assert.equal(ipc.listenerCount('error'), 0);
    assert.equal(ipc.listenerCount('disconnect'), 0);
  }
});

test('timeout bounds and disconnected channel fail before listeners', () => {
  const ipc = channel();
  assert.throws(() => readDelegationBootstrap(ipc, env, { timeoutMs: 5001 }), safeFailure);
  ipc.connected = false;
  assert.throws(() => readDelegationBootstrap(ipc, env), safeFailure);
  assert.equal(ipc.listenerCount('message'), 0);
});
