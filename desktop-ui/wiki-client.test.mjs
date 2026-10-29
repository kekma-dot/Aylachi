import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubClient } from './hub-client.mjs';
import { createWikiClient } from './wiki-client.mjs';

const bearer = 'synthetic-wiki-client-test-not-a-real-credential';
const id = '11111111-1111-4111-8111-111111111111';
const revision1 = '22222222-2222-4222-8222-222222222222';
const revision2 = '33333333-3333-4333-8333-333333333333';
const revision3 = '44444444-4444-4444-8444-444444444444';
const linkId = '55555555-5555-4555-8555-555555555555';
const note = revision => ({ id, revision });
const make = fetch => createWikiClient({ hubClient: createHubClient({ baseUrl: 'http://127.0.0.1:99', bearer, fetch }) });
const json = (body, status = 200) => Response.json(body, { status });

test('Wiki adapter follows real Hub routes and UUID revision contracts through Hub transport', async () => {
  const seen = [];
  const fixtures = [
    { body: note(revision1), status: 201 },
    { body: { ...note(revision1), content: 'alpha' } },
    { body: { ...note(revision1), content: 'alpha' } },
    { body: { notes: [note(revision1)] } },
    { body: note(revision2), status: 200 },
    { body: { revisions: [revision1, revision2] } },
    { body: { changes: [{ start: 0, remove: ['alpha\n'], insert: ['beta\n'] }] } },
    { body: { links: [linkId] } },
    { body: note(revision3), status: 200 },
  ];
  const client = make(async (url, init) => {
    seen.push({ url: new URL(url), init });
    const fixture = fixtures.shift();
    return json(fixture.body, fixture.status);
  });
  assert.deepEqual(await client.create({ content: 'alpha' }), note(revision1));
  assert.deepEqual(await client.read(id, { revision: revision1 }), { ...note(revision1), content: 'alpha' });
  assert.deepEqual(await client.read(id), { ...note(revision1), content: 'alpha' });
  assert.deepEqual(await client.search('cats & dogs/🌲'), { notes: [note(revision1)] });
  assert.deepEqual(await client.update(id, { content: 'beta', expectedRevision: revision1 }), note(revision2));
  assert.deepEqual(await client.history(id), { revisions: [revision1, revision2] });
  assert.deepEqual(await client.diff(id, { fromRevision: revision1, toRevision: revision2 }), { changes: [{ start: 0, remove: ['alpha\n'], insert: ['beta\n'] }] });
  assert.deepEqual(await client.links(id), { links: [linkId] });
  assert.deepEqual(await client.restore(id, { revision: revision1, expectedRevision: revision2 }), note(revision3));
  assert.equal(seen.length, 9);
  assert.deepEqual(seen.map(({ url, init }) => [init.method, url.pathname]), [
    ['POST', '/v1/modules/wiki/notes'],
    ['GET', `/v1/modules/wiki/notes/${id}`], ['GET', `/v1/modules/wiki/notes/${id}`],
    ['GET', '/v1/modules/wiki/notes'], ['POST', `/v1/modules/wiki/notes/${id}`],
    ['GET', `/v1/modules/wiki/notes/${id}/history`], ['GET', `/v1/modules/wiki/notes/${id}/diff`],
    ['GET', `/v1/modules/wiki/notes/${id}/links`], ['POST', `/v1/modules/wiki/notes/${id}/restore`],
  ]);
  assert.equal(seen[1].url.searchParams.get('revision'), revision1);
  assert.equal(seen[2].url.searchParams.has('revision'), false);
  assert.equal(seen[3].url.searchParams.get('query'), 'cats & dogs/🌲');
  assert.equal(seen[6].url.searchParams.get('fromRevision'), revision1);
  assert.equal(seen[6].url.searchParams.get('toRevision'), revision2);
  assert.deepEqual(JSON.parse(seen[0].init.body), { content: 'alpha' });
  assert.deepEqual(JSON.parse(seen[4].init.body), { content: 'beta', expectedRevision: revision1 });
  assert.deepEqual(JSON.parse(seen[8].init.body), { revision: revision1, expectedRevision: revision2 });
  for (const { init } of seen) {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, `Bearer ${bearer}`);
  }
});

test('invalid IDs/revisions and malformed response items never pass validation', async () => {
  assert.throws(() => createWikiClient({ hubClient: {} }), e => e.message === 'INVALID_HUB_CLIENT');
  const client = make(async () => json({}));
  assert.throws(() => client.read('../escape'), e => e.message === 'INVALID_WIKI_ID');
  assert.throws(() => client.read(id, { revision: 'revision-1' }), e => e.message === 'INVALID_REVISION');
  assert.throws(() => client.update(id, { content: 'x', expectedRevision: 3 }), e => e.message === 'INVALID_REVISION');
  assert.throws(() => client.diff(id, { fromRevision: revision1, toRevision: 'bad' }), e => e.message === 'INVALID_REVISION');

  const malformed = [
    [c => c.read(id), { id, revision: 3, content: 'text' }],
    [c => c.search('x'), { notes: [note(3)] }],
    [c => c.history(id), { revisions: [3] }],
    [c => c.diff(id, { fromRevision: revision1, toRevision: revision2 }), { changes: [{ start: 0, remove: [1], insert: [] }] }],
    [c => c.links(id), { links: ['not-a-uuid'] }],
  ];
  for (const [invoke, body] of malformed) {
    const malformedClient = make(async () => json(body));
    await assert.rejects(invoke(malformedClient), e => e.code === 'INVALID_WIKI_RESPONSE' && !e.unknownOutcome);
  }
});

test('malformed successful mutations preserve unknown outcome', async () => {
  const client = make(async () => json({ id, revision: 3 }, 201));
  await assert.rejects(client.create({ content: 'may have been written' }), e =>
    e.code === 'INVALID_WIKI_RESPONSE' && e.unknownOutcome === true && !e.cause);
});

test('conflict status and lost mutation receipt are preserved without retry or token leaks', async () => {
  let calls = 0;
  const conflict = make(async () => { calls++; return json({ message: bearer }, 409); });
  await assert.rejects(conflict.update(id, { content: 'x', expectedRevision: revision1 }), e =>
    e.code === 'HTTP_ERROR' && e.status === 409 && !e.unknownOutcome && !String(e).includes(bearer) && !e.cause);
  assert.equal(calls, 1);
  const lost = make(async () => { calls++; throw new Error(`private fetch failure ${bearer}`); });
  await assert.rejects(lost.restore(id, { revision: revision1, expectedRevision: revision2 }), e =>
    e.code === 'CONNECTION_FAILED' && e.unknownOutcome && !String(e).includes(bearer) && !e.cause);
  assert.equal(calls, 2);
});

test('AbortSignal is forwarded through the existing transport for disposable reads', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = make((_url, init) => {
    calls++;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const pending = client.read(id, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, e => e.code === 'ABORTED' && !e.unknownOutcome);
  assert.equal(calls, 1);
});

test('unexpected HTTP status and malformed top-level shape are not success', async () => {
  const status = make(async () => json({ notes: [] }, 202));
  await assert.rejects(status.search('x'), e => e.code === 'HTTP_ERROR' && e.status === 202);
  const malformed = make(async () => json({ notes: {} }));
  await assert.rejects(malformed.search('x'), e => e.code === 'INVALID_WIKI_RESPONSE');
});
