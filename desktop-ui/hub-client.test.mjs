import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHubClient } from './hub-client.mjs';
import { createHub } from '../hub/server.mjs';
import { openStore } from '../persistence/store.mjs';

const bearer = 'synthetic-ui-client-test-not-a-real-credential';
async function until(fn) {
  for (let i = 0; i < 100; i++) { const value = fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('condition did not settle');
}
async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-ui-hub-'));
  const store = openStore(join(root, 'hub.sqlite'));
  const operations = ['card.create', 'card.delete', 'snapshot.read', 'events.read', 'command.read', 'session.message', 'command.cancel'];
  const hub = createHub({
    store, bearerSecret: bearer, runner,
    authContext: { principalId: 'fixture', expiresAt: 100, revoked: false, grants: operations.map(operation => ({ effect: 'allow', permission: operation.endsWith('.read') ? 'read' : 'write', operation, projectId: 'fixture' })) },
    now: () => 1,
    resolveTarget: ({ card, input }) => ({ projectId: 'fixture', cardId: card?.id ?? input.id, sessionId: card?.sessionId ?? input.sessionId }),
  });
  const address = await hub.listen();
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, bearer };
  t.after(async () => { await hub.shutdown({ abortActive: true }); store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, client: createHubClient(options), options };
}
const card = id => ({ id, canvasId: 'canvas', sessionId: `session-${id}`, title: id, x: 0, y: 0 });

test('client uses real Hub receipts, card-local cursors and distinct sessions without automatic replay', async t => {
  let effects = 0;
  const { client, store, options } = await fixture(t, async () => { effects++; return { text: 'fixture result' }; });
  assert.equal((await client.createCard(card('a'), 'create-a')).duplicate, false);
  await client.createCard(card('b'), 'create-b');
  const before = await client.snapshot('a');
  assert.equal(before.eventSequence, 1);
  assert.notEqual(before.card.sessionId, (await client.snapshot('b')).card.sessionId);
  await client.sendMessage('b', 'B only', 'message-b');
  await until(() => store.getCommand('message-b')?.state === 'COMPLETED');
  assert.deepEqual(await client.snapshot('a'), before);
  assert.deepEqual(await client.events('a', before.eventSequence), { events: [], nextSequence: 1 });

  const receipt = await client.sendMessage('a', 'A only', 'message-a');
  assert.equal(receipt.duplicate, false);
  await until(() => store.getCommand('message-a')?.state === 'COMPLETED');
  const reconnected = createHubClient(options);
  assert.equal((await reconnected.readCommand('message-a')).command.result.text, 'fixture result');
  const page = await reconnected.events('a', before.eventSequence);
  assert.deepEqual(page.events.map(e => e.sequence), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(page.events.map(e => e.kind), ['command.reserved', 'execution.event', 'execution.event', 'execution.event', 'execution.event', 'command.completed']);
  assert.deepEqual((await reconnected.events('a', page.nextSequence)).events, []);
  assert.equal((await reconnected.sendMessage('a', 'A only', 'message-a')).duplicate, true);
  assert.equal(effects, 2);
  await assert.rejects(reconnected.sendMessage('a', 'changed payload', 'message-a'), e => e.code === 'HTTP_ERROR' && e.status === 409 && !e.unknownOutcome);
});

test('deleteCard uses the card CAS receipt and removes only the requested card', async t => {
  const { client, store } = await fixture(t, async () => ({ text: 'done' }));
  await client.createCard(card('a'), 'create-a');
  await client.createCard(card('b'), 'create-b');
  await assert.rejects(client.deleteCard('a', 2), error => error.status === 409 && !error.unknownOutcome);
  assert.deepEqual(await client.deleteCard('a', 1), { deleted: true });
  assert.equal(store.getCard('a'), undefined); assert.ok(store.getCard('b'));
  assert.throws(() => client.deleteCard('a', 0), { name: 'TypeError' });
});

test('lost POST response preserves uncertain outcome; explicit same-ID reconciliation dispatches once', async t => {
  let effects = 0, attempts = 0;
  const { client, options, store } = await fixture(t, async () => { effects++; return { text: 'done' }; });
  await client.createCard(card('a'), 'create-a');
  const disconnected = createHubClient({ ...options, fetch: async (...args) => {
    attempts++;
    const response = await fetch(...args);
    await response.body.cancel();
    throw new Error(`private transport detail ${bearer}`);
  } });
  await assert.rejects(disconnected.sendMessage('a', 'hello', 'stable-id'), e =>
    e.code === 'CONNECTION_FAILED' && e.unknownOutcome && !String(e).includes(bearer) && !e.cause);
  assert.equal(attempts, 1);
  await until(() => store.getCommand('stable-id')?.state === 'COMPLETED');
  assert.equal((await client.readCommand('stable-id')).command.state, 'COMPLETED');
  assert.equal((await client.sendMessage('a', 'hello', 'stable-id')).duplicate, true);
  assert.equal(effects, 1);
});

test('cancel receipt is not a cancelled-result claim; terminal cancel is a structured conflict', async t => {
  const { client, store } = await fixture(t, ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'CANCELLED' }), { once: true })));
  await client.createCard(card('a'), 'create-a');
  await client.sendMessage('a', 'wait', 'running');
  const receipt = await client.cancelCommand('running', 'cancel-request');
  assert.equal(receipt.command.id, 'cancel-request');
  assert.equal(receipt.command.state, 'RUNNING'); // Reservation receipt is not the final result.
  assert.equal(receipt.command.result, null);
  assert.equal((await client.readCommand('cancel-request')).command.result.status, 'accepted');
  await until(() => store.getCommand('running')?.state === 'COMPLETED');
  assert.equal((await client.readCommand('running')).command.result.status, 'cancelled');
  await assert.rejects(client.cancelCommand('running', 'cancel-again'), e => e.status === 409 && !e.unknownOutcome);
});

test('listCards returns exact empty and full authoritative card lists over safe GET', async () => {
  const records = [
    { id: 'card-a', canvasId: 'canvas-a', sessionId: 'session-a', title: 'A card', x: 125, y: -300, revision: 4 },
    { id: 'card-b', canvasId: 'canvas-a', sessionId: 'session-b', title: 'B card', x: 1_000_001, y: -1_000_001, revision: 1 },
    { id: 'card-c', canvasId: 'canvas-a', sessionId: 'session-c', title: 'Model only', x: 10, y: 20, revision: 3,
      modelProvider: 'openai-codex', modelId: 'gpt-6-luna', reasoning: 'low' },
  ];
  const responses = [{ cards: [] }, { cards: records }];
  let calls = 0;
  const client = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async (url, init) => {
    calls++;
    assert.equal(url.pathname, '/v1/cards');
    assert.equal(url.search, '?canvasId=canvas-a', 'no pagination or extra query fields');
    assert.equal(url.searchParams.get('canvasId'), 'canvas-a');
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, `Bearer ${bearer}`);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    return Response.json(responses.shift(), { status: 200 });
  } });
  assert.deepEqual(await client.listCards('canvas-a'), { cards: [] });
  assert.deepEqual(await client.listCards('canvas-a'), { cards: records });
  assert.equal(calls, 2);
});

test('listCards rejects invalid canvas IDs before fetch', () => {
  let calls = 0;
  const client = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => { calls++; throw new Error('must not fetch'); } });
  for (const canvasId of ['', '../canvas', 'canvas?token=x', 'x'.repeat(129)]) {
    assert.throws(() => client.listCards(canvasId), e => e.message === 'INVALID_ID');
  }
  assert.equal(calls, 0);
});

test('listCards rejects malformed, oversized, duplicate, wrong-canvas, and invalid card records as read-only failures', async () => {
  const fullCard = (overrides = {}) => ({ id: 'card-a', canvasId: 'canvas-a', sessionId: 'session-a', title: 'A card', x: 10, y: -20, revision: 2, ...overrides });
  const valid = fullCard();
  const tooMany = Array.from({ length: 101 }, (_, index) => fullCard({ id: `card-${index}`, sessionId: `session-${index}` }));
  const invalidPayloads = [
    [], {}, { cards: [], extra: true }, { cards: null }, { cards: [null] },
    { cards: [{ ...valid, extra: true }] },
    { cards: [{ ...valid, id: 'bad/id' }] },
    { cards: [{ ...valid, canvasId: 'canvas-other' }] },
    { cards: [{ ...valid, sessionId: 'bad/id' }] },
    { cards: [{ ...valid, title: '' }] },
    { cards: [{ ...valid, title: 'x'.repeat(4097) }] },
    { cards: [{ ...valid, x: null }] },
    { cards: [{ ...valid, x: Infinity }] },
    { cards: [{ ...valid, y: NaN }] },
    { cards: [{ ...valid, revision: 0 }] },
    { cards: [{ ...valid, revision: 1.5 }] },
    { cards: [{ ...valid, revision: Number.MAX_SAFE_INTEGER + 1 }] },
    { cards: [valid, { ...valid, sessionId: 'session-other' }] },
    { cards: tooMany },
  ];
  for (const payload of invalidPayloads) {
    const client = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => Response.json(payload, { status: 200 }) });
    await assert.rejects(client.listCards('canvas-a'), e => e.code === 'INVALID_RESPONSE' && e.unknownOutcome === false);
  }
  const oversizedBody = JSON.stringify({ cards: [fullCard({ title: 'x'.repeat(70 * 1024) })] });
  const oversized = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () =>
    new Response(oversizedBody, { status: 200, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(oversized.listCards('canvas-a'), e => e.code === 'RESPONSE_TOO_LARGE' && e.unknownOutcome === false);
});

test('listCards preserves 413 and 404 and makes one credential-safe attempt on transport failure', async () => {
  for (const status of [413, 404]) {
    const client = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => Response.json({ detail: bearer }, { status }) });
    await assert.rejects(client.listCards('canvas-a'), e => e.code === 'HTTP_ERROR' && e.status === status &&
      e.unknownOutcome === false && !String(e).includes(bearer) && !e.cause);
  }
  let calls = 0;
  const failed = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => {
    calls++; throw new Error(`private connection detail ${bearer}`);
  } });
  await assert.rejects(failed.listCards('canvas-a'), e => e.code === 'CONNECTION_FAILED' && e.unknownOutcome === false &&
    !String(e).includes(bearer) && !e.cause);
  assert.equal(calls, 1);
});

test('moveCard sends only revision and coordinates and validates the complete 200 receipt', async () => {
  const input = { expectedRevision: 4, x: 125.5, y: -900 };
  const expectedCard = { id: 'card-a', canvasId: 'canvas-a', sessionId: 'session-a', title: 'A card', x: input.x, y: input.y, revision: 5 };
  let calls = 0;
  const client = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async (url, init) => {
    calls++;
    assert.equal(url.pathname, '/v1/cards/card-a/position');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, `Bearer ${bearer}`);
    assert.deepEqual(JSON.parse(init.body), input);
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ['expectedRevision', 'x', 'y']);
    return Response.json({ card: expectedCard }, { status: 200 });
  } });
  assert.deepEqual(await client.moveCard('card-a', input), { card: expectedCard });
  assert.equal(calls, 1);
});

test('moveCard rejects malformed inputs before fetch', () => {
  let calls = 0;
  const client = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => { calls++; throw new Error('must not fetch'); } });
  assert.throws(() => client.moveCard('../escape', { expectedRevision: 1, x: 0, y: 0 }), e => e.message === 'INVALID_ID');
  const invalidPositions = [
    null, [], {},
    { expectedRevision: 0, x: 0, y: 0 },
    { expectedRevision: 1.5, x: 0, y: 0 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1, x: 0, y: 0 },
    { expectedRevision: 1, x: NaN, y: 0 },
    { expectedRevision: 1, x: Infinity, y: 0 },
    { expectedRevision: 1, x: 1_000_001, y: 0 },
    { expectedRevision: 1, x: 0, y: -1_000_001 },
    { expectedRevision: 1, x: 0 },
    { expectedRevision: 1, x: 0, y: 0, requestId: 'forbidden' },
    { expectedRevision: 1, x: 0, y: 0, extra: true },
  ];
  for (const position of invalidPositions) assert.throws(() => client.moveCard('card-a', position), e => e.message === 'INVALID_POSITION');
  assert.equal(calls, 0);
});

test('moveCard treats malformed or mismatched 200 receipts as uncertain mutations', async () => {
  const input = { expectedRevision: 4, x: 125.5, y: -900 };
  const validCard = { id: 'card-a', canvasId: 'canvas-a', sessionId: 'session-a', title: 'A card', x: input.x, y: input.y, revision: 5 };
  const invalidCards = [
    null,
    { ...validCard, id: 'other-card' },
    { ...validCard, canvasId: 'bad/id' },
    { ...validCard, sessionId: '' },
    { ...validCard, title: '' },
    { ...validCard, title: 'x'.repeat(4097) },
    { ...validCard, x: input.x + 1 },
    { ...validCard, y: input.y + 1 },
    { ...validCard, revision: 4 },
    { ...validCard, revision: '5' },
  ];
  for (const card of invalidCards) {
    const client = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => Response.json({ card }, { status: 200 }) });
    await assert.rejects(client.moveCard('card-a', input), e => e.code === 'INVALID_RESPONSE' && e.unknownOutcome === true);
  }
  const wrongEnvelope = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => Response.json({ position: validCard }, { status: 200 }) });
  await assert.rejects(wrongEnvelope.moveCard('card-a', input), e => e.code === 'INVALID_RESPONSE' && e.unknownOutcome === true);
});

test('moveCard preserves definitive 409 and redacts lost receipts without retries', async () => {
  const input = { expectedRevision: 4, x: 20, y: 30 };
  let conflictCalls = 0;
  const conflict = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => {
    conflictCalls++; return Response.json({ detail: bearer }, { status: 409 });
  } });
  await assert.rejects(conflict.moveCard('card-a', input), e => e.code === 'HTTP_ERROR' && e.status === 409 && !e.unknownOutcome &&
    !String(e).includes(bearer) && !e.cause);
  assert.equal(conflictCalls, 1);

  let lostCalls = 0;
  const lost = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: async () => {
    lostCalls++; throw new Error(`private transport detail ${bearer}`);
  } });
  await assert.rejects(lost.moveCard('card-a', input), e => e.code === 'CONNECTION_FAILED' && e.unknownOutcome &&
    !String(e).includes(bearer) && !e.cause);
  assert.equal(lostCalls, 1);
});

test('unsafe origins, invalid input and already-aborted requests never invoke transport', async () => {
  let calls = 0;
  const fake = async () => { calls++; throw Error('not reached'); };
  for (const baseUrl of ['https://example.com', 'http://localhost:99', 'http://127.0.0.1:99/path', 'http://u:p@127.0.0.1:99', 'http://127.0.0.1:99/?token=x', 'http://0.0.0.0:99']) {
    assert.throws(() => createHubClient({ baseUrl, bearer, fetch: fake }));
  }
  const client = createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch: fake });
  assert.throws(() => client.sendMessage('../escape', 'text', 'id'));
  assert.throws(() => client.sendMessage('a', ' ', 'id'));
  assert.throws(() => client.sendMessage('a', '界'.repeat(6000), 'id'));
  assert.throws(() => client.events('a', -1));
  await assert.rejects(client.sendMessage('a', 'text', 'id', AbortSignal.abort()), e => e.code === 'ABORTED' && !e.unknownOutcome);
  assert.equal(calls, 0);
});

test('transport is nonpersistent and redirection-disabled; responses are bounded and cursors validated', async () => {
  const options = { baseUrl: 'http://127.0.0.1:99', bearer };
  const client = createHubClient({ ...options, fetch: async (url, init) => {
    assert.equal(url.origin, options.baseUrl);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, `Bearer ${bearer}`);
    return Response.json({ events: [{ sequence: 17, kind: 'wrong-global-offset' }], nextSequence: 17 });
  } });
  await assert.rejects(client.events('a', 1), e => e.code === 'INVALID_RESPONSE');
  const oversized = createHubClient({ ...options, fetch: async () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(oversized.readCommand('a'), e => e.code === 'RESPONSE_TOO_LARGE');
  const malformed = createHubClient({ ...options, fetch: async () => new Response('not json', { status: 202, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(malformed.sendMessage('a', 'hello', 'id'), e => e.code === 'INVALID_RESPONSE' && e.unknownOutcome && !String(e).includes('not json'));
  const unexpectedSuccess = createHubClient({ ...options, fetch: async () => Response.json({}) });
  await assert.rejects(unexpectedSuccess.sendMessage('a', 'hello', 'id'), e => e.code === 'HTTP_ERROR' && e.status === 200 && e.unknownOutcome);
});

test('real HTTP redirect cannot forward bearer to another loopback origin', async t => {
  let leakedRequests = 0;
  const sink = createServer((req, res) => { leakedRequests++; res.end('{}'); });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  const redirect = createServer((req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${sink.address().port}/` }); res.end(); });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.all([sink, redirect].map(server => new Promise(resolve => server.close(resolve)))); });
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${redirect.address().port}`, bearer });
  await assert.rejects(client.snapshot('a'), e => e.code === 'CONNECTION_FAILED');
  assert.equal(leakedRequests, 0);
});

test('deadline bounds a stalled response body; mutation timeout is uncertain without retry', async t => {
  let requests = 0;
  const stalled = createServer((req, res) => {
    requests++;
    res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
    res.write('{'); // Deadline must cover the body, not only receipt of headers.
  });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  t.after(async () => { stalled.closeAllConnections(); await new Promise(resolve => stalled.close(resolve)); });
  const client = createHubClient({ baseUrl: `http://127.0.0.1:${stalled.address().port}`, bearer, timeoutMs: 50 });
  await assert.rejects(client.snapshot('a'), e => e.code === 'CONNECTION_FAILED' && !e.unknownOutcome);
  await assert.rejects(client.sendMessage('a', 'text', 'id'), e => e.code === 'CONNECTION_FAILED' && e.unknownOutcome);
  assert.equal(requests, 2);
});


test('moduleRequest confines module routes, method/status, bounds, and never retries', async () => {
  let calls = 0;
  const options = { baseUrl: 'http://127.0.0.1:99', bearer };
  const client = createHubClient({ ...options, fetch: async (url, init) => {
    calls++;
    assert.equal(url.pathname, '/v1/modules/wiki/ping');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${bearer}`);
    return Response.json({ ok: true }, { status: 201 });
  } });
  assert.deepEqual(await client.moduleRequest({ method: 'POST', path: '/v1/modules/wiki/ping', body: { ok: true } }), { ok: true });
  assert.equal(calls, 1);
  for (const args of [
    { method: 'PUT', path: '/v1/modules/wiki/ping' },
    { method: 'GET', path: '/v1/modules/wiki/../cards' },
    { method: 'POST', path: '/v1/cards' },
    { method: 'GET', path: '/v1/modules/wiki/ping', body: {} },
  ]) assert.throws(() => client.moduleRequest(args), TypeError);
  await assert.rejects(client.moduleRequest({ method: 'POST', path: '/v1/modules/wiki/ping', body: { content: 'x'.repeat(65536) } }), e => e.message === 'REQUEST_TOO_LARGE');
  assert.equal(calls, 1);
});
