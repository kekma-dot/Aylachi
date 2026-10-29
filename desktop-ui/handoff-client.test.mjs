import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createHubClient } from './hub-client.mjs';
import { createHandoffClient } from './handoff-client.mjs';

const bearer = 'synthetic-handoff-client-test-not-a-real-credential';
const handoffId = '11111111-1111-4111-8111-111111111111';
const wikiRevision = '22222222-2222-4222-8222-222222222222';
const commandSource = { cardId: 'source-a', kind: 'command', id: 'command-42' };
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const payloadHash = (source, targetCardId) => digest(JSON.stringify({ action: 'propose', source, targetCardId }));
const makeClient = fetch => createHandoffClient({ hubClient: createHubClient({ baseUrl: 'http://127.0.0.1:9911', bearer, fetch }) });
const json = (body, status = 200) => Response.json(body, { status });

function record({ id = handoffId, source = commandSource, targetCardId = 'target-b', requestId = 'send-1', state = 'pending', acceptedAt = null, text = 'safe completed result' } = {}) {
  return {
    id, owner: 'owner', requestId, payloadHash: payloadHash(source, targetCardId), state, source, targetCardId,
    snapshot: { text, sha256: digest(text) }, createdAt: 100, acceptedAt,
  };
}
const envelope = (value, duplicate = false) => ({ record: value, duplicate });
const summary = value => ({ ...value, snapshot: { sha256: value.snapshot.sha256 } });

function responseClient(response) { return makeClient(async () => response); }

test('real Hub transport carries exact proposal/read/list/accept routes, headers and payloads', async () => {
  const pending = record();
  const accepted = { ...pending, state: 'accepted', acceptedAt: 200 };
  const responses = [envelope(pending), { record: pending }, { items: [summary(pending)] }, envelope(accepted), envelope(accepted, true), envelope(accepted, true)];
  const seen = [];
  const client = makeClient(async (url, init) => {
    seen.push({ url: new URL(url), init });
    return json(responses.shift(), 200);
  });

  const proposal = await client.propose({ requestId: 'send-1', source: commandSource, targetCardId: 'target-b' });
  assert.equal(proposal.duplicate, false);
  assert.deepEqual(proposal.record, pending);
  assert.deepEqual((await client.read(handoffId)).record, pending);
  const listed = await client.list('target-b');
  assert.deepEqual(listed.items, [summary(pending)]);
  assert.equal(Object.hasOwn(listed.items[0].snapshot, 'text'), false);
  const receipt = await client.accept(handoffId, { requestId: 'accept-1' });
  assert.equal(receipt.record.state, 'accepted');
  assert.equal(receipt.record.requestId, 'send-1', 'accept receipt retains original proposal ID, not accept request ID');
  assert.equal(receipt.duplicate, false);
  assert.equal((await client.accept(handoffId, { requestId: 'accept-2' })).duplicate, true);
  assert.equal((await client.propose({ requestId: 'send-1', source: commandSource, targetCardId: 'target-b' })).duplicate, true);

  assert.equal(seen.length, 6);
  assert.deepEqual(seen.map(({ url, init }) => [init.method, url.pathname]), [
    ['POST', '/v1/modules/handoff'], ['GET', `/v1/modules/handoff/${handoffId}`],
    ['GET', '/v1/modules/handoff'], ['POST', `/v1/modules/handoff/${handoffId}/accept`],
    ['POST', `/v1/modules/handoff/${handoffId}/accept`], ['POST', '/v1/modules/handoff'],
  ]);
  assert.equal(seen[2].url.searchParams.get('targetCardId'), 'target-b');
  assert.equal(seen[2].url.searchParams.get('limit'), '20');
  assert.equal(seen[2].url.searchParams.get('offset'), '0');
  assert.deepEqual(JSON.parse(seen[0].init.body), { requestId: 'send-1', source: commandSource, targetCardId: 'target-b' });
  assert.deepEqual(JSON.parse(seen[3].init.body), { requestId: 'accept-1' });
  for (const { init } of seen) {
    assert.equal(init.headers.Authorization, `Bearer ${bearer}`);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
  }
  assert.notEqual(pending.payloadHash, pending.snapshot.sha256, 'request identity and snapshot digest are distinct fields');
});

test('Wiki revision is normalized UUID; command IDs and request IDs remain generic safe IDs', async () => {
  const inputSource = { cardId: 'wiki-source', kind: 'wiki', id: 'note-safe-id', revision: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE' };
  const source = { ...inputSource, revision: inputSource.revision.toLowerCase() };
  const expected = record({ source, targetCardId: 'target-wiki', requestId: 'send-doc' });
  let body;
  const client = makeClient(async (_url, init) => { body = JSON.parse(init.body); return json(envelope(expected)); });
  const result = await client.propose({ requestId: 'send-doc', source: inputSource, targetCardId: 'target-wiki' });
  assert.equal(result.record.requestId, 'send-doc');
  assert.deepEqual(body.source, source);
  assert.equal(body.requestId, 'send-doc');
});

test('invalid inputs and list bounds fail before transport', () => {
  let calls = 0;
  const client = makeClient(async () => { calls++; return json({}); });
  assert.throws(() => client.propose({ requestId: 'bad/id', source: commandSource, targetCardId: 'target-b' }), e => e.message === 'INVALID_PROPOSAL');
  assert.throws(() => client.propose({ requestId: 'x'.repeat(129), source: commandSource, targetCardId: 'target-b' }), e => e.message === 'INVALID_PROPOSAL');
  assert.throws(() => client.propose({ requestId: 'send-1', source: { ...commandSource, revision: wikiRevision }, targetCardId: 'target-b' }), e => e.message === 'INVALID_SOURCE');
  assert.throws(() => client.propose({ requestId: 'send-1', source: { cardId: 'source-a', kind: 'wiki', id: 'note-a' }, targetCardId: 'target-b' }), e => e.message === 'INVALID_SOURCE');
  assert.throws(() => client.propose({ requestId: 'send-1', source: commandSource, targetCardId: 'source-a' }), e => e.message === 'INVALID_PROPOSAL');
  assert.throws(() => client.read('not-a-uuid'), e => e.message === 'INVALID_HANDOFF_ID');
  assert.throws(() => client.list('target-b', { limit: 21 }), e => e.message === 'INVALID_HANDOFF_RANGE');
  assert.throws(() => client.list('target-b', { offset: -1 }), e => e.message === 'INVALID_HANDOFF_RANGE');
  assert.throws(() => client.accept(handoffId, { requestId: 'bad id' }), e => e.message === 'INVALID_ACCEPT');
  assert.equal(calls, 0);
});

test('mismatched and malformed receipts fail closed; successful malformed mutations are uncertain', async () => {
  const expected = record();
  const proposals = [
    { ...expected, requestId: 'other-send' },
    { ...expected, source: { ...expected.source, id: 'other-command' } },
    { ...expected, targetCardId: 'other-target' },
    { ...expected, snapshot: { ...expected.snapshot, text: 'x'.repeat(16 * 1024 + 1), sha256: digest('x'.repeat(16 * 1024 + 1)) } },
  ];
  for (const item of proposals) {
    const client = responseClient(json(envelope(item)));
    await assert.rejects(client.propose({ requestId: 'send-1', source: commandSource, targetCardId: 'target-b' }), e =>
      e.code === 'INVALID_HANDOFF_RESPONSE' && e.unknownOutcome === true && !e.cause);
  }
  const readMismatch = responseClient(json({ record: record({ id: '22222222-2222-4222-8222-222222222222' }) }));
  await assert.rejects(readMismatch.read(handoffId), e => e.code === 'INVALID_HANDOFF_RESPONSE' && !e.unknownOutcome);
  const wrongTargetList = responseClient(json({ items: [summary(record({ targetCardId: 'other-target' }))] }));
  await assert.rejects(wrongTargetList.list('target-b'), e => e.code === 'INVALID_HANDOFF_RESPONSE' && !e.unknownOutcome);
  const leakedTextList = responseClient(json({ items: [{ ...summary(expected), snapshot: { ...summary(expected).snapshot, text: 'must not be returned' } }] }));
  await assert.rejects(leakedTextList.list('target-b'), e => e.code === 'INVALID_HANDOFF_RESPONSE' && !e.unknownOutcome);
  const badAcceptId = responseClient(json(envelope({ ...record(), state: 'accepted', acceptedAt: 200, id: '22222222-2222-4222-8222-222222222222' })));
  await assert.rejects(badAcceptId.accept(handoffId, { requestId: 'accept-1' }), e => e.code === 'INVALID_HANDOFF_RESPONSE' && e.unknownOutcome === true);
  const badAcceptState = responseClient(json(envelope(expected)));
  await assert.rejects(badAcceptState.accept(handoffId, { requestId: 'accept-1' }), e => e.code === 'INVALID_HANDOFF_RESPONSE' && e.unknownOutcome === true);
  const malformedMutation = responseClient(json({ record: {}, duplicate: false }));
  await assert.rejects(malformedMutation.propose({ requestId: 'send-1', source: commandSource, targetCardId: 'target-b' }), e =>
    e.code === 'INVALID_HANDOFF_RESPONSE' && e.unknownOutcome === true);
});

test('hash fields must be JSON strings in full records and list summaries', async () => {
  const variants = [['array', ['a'.repeat(64)]], ['number', 123]];
  const corrupt = (value, field, hash) => field === 'payloadHash'
    ? { ...value, payloadHash: hash }
    : { ...value, snapshot: { ...value.snapshot, sha256: hash } };

  for (const [kind, hash] of variants) {
    for (const field of ['payloadHash', 'snapshot.sha256']) {
      const full = corrupt(record(), field, hash);
      const read = responseClient(json({ record: full }));
      await assert.rejects(read.read(handoffId), e => e.code === 'INVALID_HANDOFF_RESPONSE' && e.unknownOutcome === false,
        `GET full record rejects ${kind} ${field}`);
      const listItem = corrupt(summary(record()), field, hash);
      const list = responseClient(json({ items: [listItem] }));
      await assert.rejects(list.list('target-b'), e => e.code === 'INVALID_HANDOFF_RESPONSE' && e.unknownOutcome === false,
        `GET list summary rejects ${kind} ${field}`);
      const post = responseClient(json(envelope(full)));
      await assert.rejects(post.propose({ requestId: 'send-1', source: commandSource, targetCardId: 'target-b' }), e =>
        e.code === 'INVALID_HANDOFF_RESPONSE' && e.unknownOutcome === true,
      `POST rejects ${kind} ${field} with uncertain outcome`);
    }
  }
});

test('known HTTP errors preserve status; lost POST response is unknown, redacted, and not retried', async () => {
  let calls = 0;
  const conflict = makeClient(async () => { calls++; return json({ detail: bearer }, 409); });
  await assert.rejects(conflict.propose({ requestId: 'send-1', source: commandSource, targetCardId: 'target-b' }), e =>
    e.code === 'HTTP_ERROR' && e.status === 409 && !e.unknownOutcome && !String(e).includes(bearer) && !e.cause);
  assert.equal(calls, 1);
  const lost = makeClient(async () => { calls++; throw new Error(`private fetch failure ${bearer}`); });
  await assert.rejects(lost.accept(handoffId, { requestId: 'accept-1' }), e =>
    e.code === 'CONNECTION_FAILED' && e.unknownOutcome && !String(e).includes(bearer) && !e.cause);
  assert.equal(calls, 2);
});

test('AbortSignal reaches existing Hub transport for reads', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = makeClient((_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const pending = client.read(handoffId, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, e => e.code === 'ABORTED' && !e.unknownOutcome);
  assert.equal(calls, 1);
});

test('oversized transport response is bounded and mutation outcome remains unknown', async () => {
  const client = makeClient(async () => new Response(`{"record":${' '.repeat(64 * 1024)}}`, { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.propose({ requestId: 'send-1', source: commandSource, targetCardId: 'target-b' }), e =>
    e.code === 'RESPONSE_TOO_LARGE' && e.unknownOutcome === true);
});
