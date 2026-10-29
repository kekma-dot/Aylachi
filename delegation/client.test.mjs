import assert from 'node:assert/strict';
import test from 'node:test';
import { createDelegationClient } from './client.mjs';

const baseUrl = 'http://127.0.0.1:46231';
const bearer = 'x'.repeat(48);
const parentCommandId = 'parent-command-1';
const taskId = 'task-1';
const requestId = 'request-1';
const id = value => value;
function record(overrides = {}) {
  return {
    id: taskId, requestId, parentCommandId, parentCardId: 'parent-card-1', canvasId: 'canvas-1',
    childCardId: 'child-card-1', childSessionId: 'child-session-1', childCommandId: 'child-command-1',
    state: 'DISPATCHED', result: null, ...overrides,
  };
}
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function client(fetch, options = {}) {
  return createDelegationClient({ baseUrl, bearer, parentCommandId, fetch, timeoutMs: 1000, waitTimeoutMs: 1000, pollIntervalMs: 1, ...options });
}
function coded(code) {
  return error => error?.code === code;
}

test('validates an exact loopback base URL and credential before any request', () => {
  let calls = 0;
  const fetch = async () => { calls++; return jsonResponse({}); };
  for (const invalid of ['http://localhost:46231', 'http://127.0.0.2:46231', 'https://127.0.0.1:46231', 'http://127.0.0.1:46231/path', 'http://user@127.0.0.1:46231', 'http://127.0.0.1:46231?x=1']) {
    assert.throws(() => createDelegationClient({ baseUrl: invalid, bearer, parentCommandId, fetch }), { message: 'LOOPBACK_ORIGIN_REQUIRED' });
  }
  assert.throws(() => createDelegationClient({ baseUrl, bearer: 'short', parentCommandId, fetch }), { message: 'INVALID_BEARER' });
  assert.throws(() => createDelegationClient({ baseUrl, bearer, parentCommandId: 'bad id', fetch }), { message: 'INVALID_PARENT_COMMAND_ID' });
  assert.equal(calls, 0);
});

test('delegate sends the exact single POST payload and returns only the whitelisted projection', async () => {
  const calls = [];
  const api = client(async (url, init) => { calls.push({ url: String(url), init }); return jsonResponse({ record: record(), duplicate: false }, 201); });
  const result = await api.delegate({ requestId, text: 'Do one task' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${baseUrl}/v1/modules/delegation`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${bearer}`);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)).sort(), ['parentCommandId', 'requestId', 'text']);
  assert.deepEqual(JSON.parse(calls[0].init.body), { parentCommandId, requestId, text: 'Do one task' });
  assert.deepEqual(result, { record: record(), duplicate: false });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.record), true);
  assert.deepEqual(Object.keys(api).sort(), ['delegate', 'wait']);
});

test('successful duplicate receipt is returned without retry', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return jsonResponse({ record: record({ state: 'COMPLETED', result: { status: 'ok', text: 'done' } }), duplicate: true }, 200); });
  const result = await api.delegate({ requestId, text: 'Do one task' });
  assert.equal(result.duplicate, true);
  assert.equal(result.record.result.text, 'done');
  assert.equal(calls, 1);
});

test('200 unknown outcome throws a safe error with only the validated record and never retries', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return jsonResponse({ record: record({ state: 'NEEDS_RECONCILIATION' }), duplicate: false, outcome: 'unknown' }, 200); });
  await assert.rejects(api.delegate({ requestId, text: 'Do one task' }), error => {
    assert.equal(error.code, 'DELEGATE_OUTCOME_UNKNOWN');
    assert.equal(error.message, 'DELEGATE_OUTCOME_UNKNOWN');
    assert.deepEqual(error.record, record({ state: 'NEEDS_RECONCILIATION' }));
    assert.equal(Object.isFrozen(error.record), true);
    assert.equal('taskId' in error, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('unknown POST transport failure is redacted and not retried', async () => {
  let calls = 0;
  const api = client(async () => { calls++; throw new Error(`leaked ${bearer}`); });
  await assert.rejects(api.delegate({ requestId, text: 'Do one task' }), error => {
    assert.equal(error.code, 'DELEGATE_OUTCOME_UNKNOWN');
    assert.equal(error.message, 'DELEGATE_OUTCOME_UNKNOWN');
    assert.equal(JSON.stringify(error).includes(bearer), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('wait polls only the task GET until completion and validates parent identity', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ record: calls.length === 1 ? record() : record({ state: 'COMPLETED', result: { status: 'ok', text: 'finished' } }) });
  });
  const result = await api.wait(taskId);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.result.text, 'finished');
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.init.method === 'GET' && call.init.body === undefined));
  assert(calls.every(call => call.url === `${baseUrl}/v1/modules/delegation/${taskId}`));
  const mismatch = client(async () => jsonResponse({ record: record({ parentCommandId: 'other-parent' }) }));
  await assert.rejects(mismatch.wait(taskId), coded('INVALID_RESPONSE'));
});

test('wait returns terminal cancelled/error results and maps HTTP errors safely', async () => {
  for (const result of [{ status: 'cancelled' }, { status: 'error', code: 'CHILD_FAILED' }]) {
    const api = client(async () => jsonResponse({ record: record({ state: 'COMPLETED', result }) }));
    assert.deepEqual((await api.wait(taskId)).result, result);
  }
  const api = client(async () => new Response('', { status: 409 }));
  await assert.rejects(api.wait(taskId), coded('CONFLICT'));
});

test('malformed and oversized POST receipts become unknown outcomes without retry', async () => {
  for (const response of [
    new Response('not json', { status: 201, headers: { 'content-type': 'application/json' } }),
    new Response(' '.repeat(70 * 1024), { status: 201, headers: { 'content-type': 'application/json' } }),
    jsonResponse({ record: record({ extra: true }), duplicate: false }, 201),
    jsonResponse({ record: record({ parentCommandId: 'wrong-parent' }), duplicate: false }, 201),
  ]) {
    let calls = 0;
    const api = client(async () => { calls++; return response; });
    await assert.rejects(api.delegate({ requestId, text: 'Do one task' }), coded('DELEGATE_OUTCOME_UNKNOWN'));
    assert.equal(calls, 1);
  }
});

test('accessor-bearing receipt data is rejected without invoking getters', async () => {
  const maliciousRecord = record();
  let getterCalls = 0;
  Object.defineProperty(maliciousRecord, 'id', { enumerable: true, get() { getterCalls++; return taskId; } });
  const payload = { record: maliciousRecord, duplicate: false };
  const oldParse = JSON.parse;
  let calls = 0;
  const api = client(async () => { calls++; return jsonResponse({}); });
  JSON.parse = () => payload;
  try {
    await assert.rejects(api.delegate({ requestId, text: 'Do one task' }), coded('DELEGATE_OUTCOME_UNKNOWN'));
  } finally { JSON.parse = oldParse; }
  assert.equal(getterCalls, 0);
  assert.equal(calls, 1);
});

test('invalid/accessor inputs and pre-aborted signal are rejected before fetch', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return jsonResponse({}); });
  const input = { requestId, text: 'task' };
  Object.defineProperty(input, 'text', { enumerable: true, get() { throw new Error('must not run'); } });
  await assert.rejects(api.delegate(input), error => error instanceof TypeError && error.message === 'INVALID_INPUT');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.delegate({ requestId, text: 'task' }, { signal: controller.signal }), coded('ABORTED'));
  assert.equal(calls, 0);
});

test('hanging fetch settles on request deadline or signal even when fetch ignores abort', async () => {
  let postCalls = 0;
  const timed = client(async () => { postCalls++; return new Promise(() => {}); }, { timeoutMs: 15 });
  await assert.rejects(timed.delegate({ requestId, text: 'task' }), coded('DELEGATE_OUTCOME_UNKNOWN'));
  assert.equal(postCalls, 1);

  let getCalls = 0;
  const api = client(async () => { getCalls++; return new Promise(() => {}); }, { timeoutMs: 1000 });
  const controller = new AbortController();
  const pending = api.wait(taskId, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, coded('ABORTED'));
  assert.equal(getCalls, 1);
});
