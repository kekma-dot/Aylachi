import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openHandoffStore } from './store.mjs';

const source = { cardId: 'source-card', kind: 'command', id: 'command-1' };
const wikiSource = { cardId: 'wiki-card', kind: 'wiki', id: 'note-1', revision: '22222222-2222-4222-8222-222222222222' };
const proposal = (extra = {}) => ({ actor: 'alice', requestId: 'propose-1', source, targetCardId: 'target-card', snapshot: { text: 'immutable text' }, now: 100, ...extra });
const codeIs = code => error => error?.code === code;

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'aylachi-handoff-'));
  const path = join(dir, 'handoff.sqlite');
  let store = openHandoffStore(path);
  const api = {
    path,
    get store() { return store; },
    close() { store?.close(); store = null; },
    reopen() { store?.close(); store = openHandoffStore(path); return store; },
  };
  try { await run(api); }
  finally { api.close(); await rm(dir, { recursive: true, force: true }); }
}

function integrity(path) {
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
}

test('proposal retry returns immutable original snapshot; request hash binds source and target, not snapshot', async () => withStore(({ store }) => {
  const first = store.propose(proposal());
  assert.equal(first.duplicate, false);
  assert.match(first.record.id, /^[0-9a-f-]{36}$/i);
  assert.equal(first.record.state, 'pending');
  assert.equal(first.record.acceptedAt, null);
  assert.equal(first.record.createdAt, 100);
  assert.equal(first.record.owner, 'alice');
  assert.equal(first.record.requestId, 'propose-1');
  assert.deepEqual(first.record.source, source);
  assert.equal(first.record.targetCardId, 'target-card');
  assert.deepEqual(first.record.snapshot, {
    text: 'immutable text',
    sha256: createHash('sha256').update('immutable text', 'utf8').digest('hex'),
  });
  const expectedHash = createHash('sha256').update(JSON.stringify({ action: 'propose', source, targetCardId: 'target-card' })).digest('hex');
  assert.equal(first.record.payloadHash, expectedHash);

  const retry = store.propose(proposal({ snapshot: { text: 'changed source text' }, now: 999 }));
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.record, first.record);
  assert.equal(store.list({ actor: 'alice', targetCardId: 'target-card' }).length, 1);
}));

test('actor/requestId namespace rejects changed payload or action', async () => withStore(({ store }) => {
  const created = store.propose(proposal());
  assert.throws(() => store.propose(proposal({ source: { ...source, id: 'command-2' } })), codeIs('CONFLICT'));
  assert.throws(() => store.propose(proposal({ targetCardId: 'another-target' })), codeIs('CONFLICT'));
  assert.throws(() => store.accept({ actor: 'alice', id: created.record.id, requestId: 'propose-1', now: 101 }), codeIs('CONFLICT'));
  assert.equal(store.get({ actor: 'alice', id: created.record.id }).state, 'pending');
}));

test('wiki source revision is normalized and owner-scoped reads hide other actors', async () => withStore(({ store }) => {
  const created = store.propose(proposal({ source: { ...wikiSource, revision: wikiSource.revision.toUpperCase() } }));
  assert.equal(created.record.source.revision, wikiSource.revision);
  assert.equal(store.get({ actor: 'bob', id: created.record.id }), undefined);
  assert.equal(store.get({ actor: 'alice', id: 'missing-id' }), undefined);
  assert.throws(() => store.get({ actor: '', id: created.record.id }), codeIs('INVALID_REQUEST'));
  assert.throws(() => store.accept({ actor: 'bob', id: created.record.id, requestId: 'bob-accept', now: 101 }), codeIs('NOT_FOUND'));
  assert.deepEqual(store.list({ actor: 'bob', targetCardId: 'target-card' }), []);
  assert.deepEqual(store.list({ actor: 'alice', targetCardId: 'target-card' }), [created.record]);
}));

test('accept is atomic, owner-bound, survives reopen, and retries create no second effect', async () => withStore(({ path, store, reopen }) => {
  const created = store.propose(proposal());
  const accepted = store.accept({ actor: 'alice', id: created.record.id, requestId: 'accept-1', now: 200 });
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.record.state, 'accepted');
  assert.equal(accepted.record.acceptedAt, 200);
  const again = store.accept({ actor: 'alice', id: created.record.id, requestId: 'accept-1', now: 300 });
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.record, accepted.record);
  const otherRequest = store.accept({ actor: 'alice', id: created.record.id, requestId: 'accept-2', now: 400 });
  assert.equal(otherRequest.duplicate, true);
  assert.equal(otherRequest.record.acceptedAt, 200);
  const reopened = reopen();
  assert.deepEqual(reopened.get({ actor: 'alice', id: created.record.id }), accepted.record);
  assert.equal(reopened.list({ actor: 'alice', targetCardId: 'target-card' }).length, 1);
  integrity(path);
}));

test('failed proposal/accept transactions leave no partial record or consumed request ID', async () => withStore(({ path, store, reopen, close }) => {
  close();
  let db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER fail_proposal BEFORE INSERT ON handoff_requests
    WHEN NEW.action='propose' BEGIN SELECT RAISE(ABORT,'forced proposal failure'); END;`);
  db.close();
  let current = reopen();
  assert.throws(() => current.propose(proposal()), /forced proposal failure/);
  close();
  db = new DatabaseSync(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoff_records').get().n, 0);
  db.exec('DROP TRIGGER fail_proposal');
  db.close();

  current = reopen();
  const created = current.propose(proposal());
  close();
  db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER fail_accept BEFORE UPDATE OF state ON handoff_records
    BEGIN SELECT RAISE(ABORT,'forced accept failure'); END;`);
  db.close();
  current = reopen();
  assert.throws(() => current.accept({ actor: 'alice', id: created.record.id, requestId: 'accept-retry', now: 200 }), /forced accept failure/);
  close();
  db = new DatabaseSync(path);
  assert.equal(db.prepare('SELECT state FROM handoff_records WHERE id=?').get(created.record.id).state, 'pending');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM handoff_requests WHERE request_id='accept-retry'").get().n, 0);
  db.exec('DROP TRIGGER fail_accept');
  db.close();

  current = reopen();
  const accepted = current.accept({ actor: 'alice', id: created.record.id, requestId: 'accept-retry', now: 201 });
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.record.state, 'accepted');
  integrity(path);
}));

test('validates identifiers, wiki/command source shapes, times, listing bounds, and both snapshot byte limits', async () => withStore(({ store }) => {
  const invalid = [
    proposal({ actor: 'bad actor' }),
    proposal({ requestId: 'x'.repeat(129) }),
    proposal({ source: { ...source, cardId: 'target-card' } }),
    proposal({ source: { ...source, revision: wikiSource.revision } }),
    proposal({ source: { cardId: 'wiki-card', kind: 'wiki', id: 'note-1' } }),
    proposal({ source: { ...wikiSource, revision: 'revision-1' } }),
    proposal({ now: -1 }),
    proposal({ now: 1.5 }),
    proposal({ now: Number.MAX_SAFE_INTEGER + 1 }),
    proposal({ source: { ...source, id: 'x'.repeat(129) } }),
  ];
  for (const input of invalid) assert.throws(() => store.propose(input), codeIs('INVALID_REQUEST'));
  assert.throws(() => store.list({ actor: 'alice', targetCardId: 'target-card', limit: 21 }), codeIs('INVALID_REQUEST'));
  assert.throws(() => store.list({ actor: 'alice', targetCardId: 'target-card', offset: 100001 }), codeIs('INVALID_REQUEST'));
  assert.throws(() => store.propose(proposal({ snapshot: { text: 'é'.repeat(8193) } })), codeIs('TOO_LARGE'));
  assert.throws(() => store.propose(proposal({ snapshot: { text: '\0'.repeat(9000) } })), codeIs('TOO_LARGE'));
  assert.equal(store.list({ actor: 'alice', targetCardId: 'target-card' }).length, 0);
}));
