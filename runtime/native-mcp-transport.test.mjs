import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeMcpFetch } from './native-mcp-transport.mjs';

const endpoint = 'http://127.0.0.1:43123/mcp';
const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const post = (fetch, input = endpoint, overrides = {}) => fetch(input, { method: 'POST', body: requestBody, ...overrides });
const codeIsFailure = error => error?.code === 'NATIVE_MCP_FETCH_FAILED' && error.message === 'NATIVE_MCP_FETCH_FAILED';

async function assertStickyFailure(fetchImpl, invoke = fetch => post(fetch)) {
  let calls = 0;
  const guarded = createNativeMcpFetch({ url: endpoint, fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } });
  await assert.rejects(invoke(guarded), codeIsFailure);
  await assert.rejects(post(guarded), codeIsFailure);
  assert.equal(calls, 1, 'failed transport must latch before another underlying fetch');
}

test('canonical loopback URL and factory config are strict', () => {
  for (const url of [
    'http://localhost:43123/mcp', 'http://127.0.0.2:43123/mcp', 'http://2130706433:43123/mcp',
    'http://127.0.0.1:0/mcp', 'http://127.0.0.1:65536/mcp', 'http://127.0.0.1:043123/mcp',
    'http://user@127.0.0.1:43123/mcp', 'http://127.0.0.1:43123/mcp?x=1',
    'http://127.0.0.1:43123/mcp#fragment', 'http://127.0.0.1:43123.evil/mcp',
    'http://[::ffff:127.0.0.1]:43123/mcp', 'http://[0:0:0:0:0:0:0:1]:43123/mcp',
    'http://127.0.0.1:43123/%2e%2e/mcp',
  ]) assert.throws(() => createNativeMcpFetch({ url }), codeIsFailure, url);
  let getterCalls = 0;
  const getterConfig = Object.defineProperty({}, 'url', { enumerable: true, get() { getterCalls++; return endpoint; } });
  assert.throws(() => createNativeMcpFetch(getterConfig), codeIsFailure);
  assert.equal(getterCalls, 0);
  assert.throws(() => createNativeMcpFetch({ url: endpoint, extra: true }), codeIsFailure);
  assert.throws(() => createNativeMcpFetch({ url: endpoint, fetchImpl: {} }), codeIsFailure);
  assert.doesNotThrow(() => createNativeMcpFetch({ url: 'http://[::1]:65535/mcp' }));
});

test('POST uses only fixed headers and omits caller credentials and custom headers', async () => {
  let observed;
  const guarded = createNativeMcpFetch({ url: endpoint, fetchImpl: async (url, init) => {
    observed = { url, init, headers: Object.fromEntries(init.headers.entries()) };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } });
  const response = await post(guarded, endpoint, { headers: {
    Authorization: 'Bearer must-not-forward', Cookie: 'session=secret', 'X-Custom': 'discard-me',
    Accept: 'text/plain', 'Content-Type': 'text/plain', 'MCP-Protocol-Version': '2025-06-18',
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: { tools: [] } });
  assert.equal(observed.url, endpoint);
  assert.deepEqual(observed.headers, {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-06-18',
  });
  assert.equal(observed.init.credentials, 'omit');
  assert.equal(observed.init.redirect, 'error');
  assert.equal(observed.init.method, 'POST');
  assert.equal(observed.init.body, requestBody);
  assert.ok(observed.init.signal instanceof AbortSignal);
});

test('valid empty 202 notification response is reconstructed', async () => {
  const guarded = createNativeMcpFetch({ url: endpoint, fetchImpl: async () => new Response(null, { status: 202 }) });
  const response = await post(guarded);
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');
});

test('destination, method, body and session identifier denials latch before fetch', async () => {
  for (const invoke of [
    fetch => post(fetch, 'http://127.0.0.1:43123/other'),
    fetch => post(fetch, endpoint, { method: 'GET' }),
    fetch => post(fetch, endpoint, { method: 'DELETE' }),
    fetch => post(fetch, endpoint, { body: '{invalid' }),
    fetch => post(fetch, endpoint, { body: ' '.repeat(32 * 1024 + 1) }),
    fetch => post(fetch, endpoint, { headers: { 'MCP-Protocol-Version': '2025-03-26' } }),
    fetch => post(fetch, endpoint, { headers: { 'Mcp-Session-Id': 'must-not-pass' } }),
  ]) {
    let calls = 0;
    const guarded = createNativeMcpFetch({ url: endpoint, fetchImpl: async () => { calls++; return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
    await assert.rejects(invoke(guarded), codeIsFailure);
    await assert.rejects(post(guarded), codeIsFailure);
    assert.equal(calls, 0);
  }
  const oversized = createNativeMcpFetch({ url: endpoint, fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(post(oversized, endpoint, { headers: { 'MCP-Protocol-Version': '2025-06-18', 'mcp-protocol-version': '2025-06-18' } }), codeIsFailure);
});

test('malformed request init is rejected without invoking accessors', async () => {
  let calls = 0, getterCalls = 0;
  const guarded = createNativeMcpFetch({ url: endpoint, fetchImpl: async () => { calls++; return new Response('{}'); } });
  const init = Object.defineProperty({ method: 'POST', body: requestBody }, 'signal', { enumerable: true, get() { getterCalls++; return undefined; } });
  await assert.rejects(guarded(endpoint, init), codeIsFailure);
  assert.equal(getterCalls, 0);
  assert.equal(calls, 0);
});

test('status, redirect, content type, session header, response size and JSON failures are sticky', async () => {
  await assertStickyFailure(async () => new Response('no', { status: 401 }));
  await assertStickyFailure(async () => new Response('redirect', { status: 302, headers: { location: endpoint } }));
  await assertStickyFailure(async () => new Response('event: message\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await assertStickyFailure(async () => new Response('{}', { headers: { 'content-type': 'application/json', 'mcp-session-id': 'forbidden' } }));
  let cancelled = false;
  const tooLarge = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(20 * 1024)); controller.enqueue(new Uint8Array(20 * 1024)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json', 'content-length': '1' } });
  await assertStickyFailure(async () => tooLarge);
  assert.equal(cancelled, true);
  await assertStickyFailure(async () => new Response('{bad', { headers: { 'content-type': 'application/json' } }));
  await assertStickyFailure(async () => new Response('{}', { headers: { 'content-type': 'application/problem+json' } }));
  await assertStickyFailure(async () => new Response('notification body', { status: 202, headers: { 'content-type': 'application/json' } }));
  await assertStickyFailure(async () => new Response(null, { status: 202, headers: { 'content-type': 'text/event-stream' } }));
});

test('caller abort fails closed and does not dispatch again', async () => {
  let calls = 0;
  const guarded = createNativeMcpFetch({ url: endpoint, fetchImpl: async (_url, init) => {
    calls++;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('transport aborted')), { once: true }));
  } });
  const caller = new AbortController();
  const pending = post(guarded, endpoint, { signal: caller.signal });
  setImmediate(() => caller.abort());
  await assert.rejects(pending, codeIsFailure);
  await assert.rejects(post(guarded), codeIsFailure);
  assert.equal(calls, 1);
});

test('deadline includes a stalled full response body and cancels it', { timeout: 8_000 }, async () => {
  let cancelled = false, calls = 0;
  const guarded = createNativeMcpFetch({ url: endpoint, fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  } });
  const started = Date.now();
  await assert.rejects(post(guarded), codeIsFailure);
  assert.ok(Date.now() - started >= 4_500, 'five-second total deadline should cover response consumption');
  assert.equal(cancelled, true);
  await assert.rejects(post(guarded), codeIsFailure);
  assert.equal(calls, 1);
});
