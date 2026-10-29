import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_ID = 128;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 48 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS = { INVALID_REQUEST: 400, CONFLICT: 409, NOT_FOUND: 404, TOO_LARGE: 413 };

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.status = STATUS[code];
  throw error;
}
function exactObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail('INVALID_REQUEST');
  const keys = Reflect.ownKeys(value), allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('INVALID_REQUEST');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail('INVALID_REQUEST');
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail('INVALID_REQUEST');
  return value;
}
function safeId(value) {
  if (typeof value !== 'string' || value.length > MAX_ID || !SAFE_ID.test(value)) fail('INVALID_REQUEST');
  return value;
}
function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_REQUEST');
  return value;
}
function normalizeSource(value, targetCardId) {
  exactObject(value, ['cardId', 'kind', 'id'], ['revision']);
  const cardId = safeId(value.cardId), id = safeId(value.id);
  if (cardId === targetCardId) fail('INVALID_REQUEST');
  if (value.kind === 'command') {
    if (Object.hasOwn(value, 'revision')) fail('INVALID_REQUEST');
    return { cardId, kind: 'command', id };
  }
  if (value.kind === 'wiki') {
    if (typeof value.revision !== 'string' || !UUID.test(value.revision)) fail('INVALID_REQUEST');
    return { cardId, kind: 'wiki', id, revision: value.revision.toLowerCase() };
  }
  fail('INVALID_REQUEST');
}
function normalizeSnapshot(value) {
  exactObject(value, ['text']);
  if (typeof value.text !== 'string') fail('INVALID_REQUEST');
  if (Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES) fail('TOO_LARGE');
  const json = JSON.stringify({ text: value.text });
  if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) fail('TOO_LARGE');
  return { text: value.text, json, sha256: createHash('sha256').update(value.text, 'utf8').digest('hex') };
}
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
function record(row) {
  return row && {
    id: row.id,
    owner: row.owner,
    requestId: row.request_id,
    payloadHash: row.payload_hash,
    state: row.state,
    source: JSON.parse(row.source_json),
    targetCardId: row.target_card_id,
    snapshot: JSON.parse(row.snapshot_json),
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
  };
}

export function openHandoffStore(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) fail('INVALID_REQUEST');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS handoff_records (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      source_json TEXT NOT NULL,
      target_card_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','accepted')),
      created_at INTEGER NOT NULL CHECK(created_at >= 0),
      accepted_at INTEGER CHECK(accepted_at IS NULL OR accepted_at >= 0)
    );
    CREATE INDEX IF NOT EXISTS handoff_owner_target_created
      ON handoff_records(owner,target_card_id,created_at,id);
    CREATE TABLE IF NOT EXISTS handoff_requests (
      actor TEXT NOT NULL,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('propose','accept')),
      request_hash TEXT NOT NULL,
      handoff_id TEXT NOT NULL REFERENCES handoff_records(id),
      PRIMARY KEY(actor,request_id)
    );`);

  const recordById = db.prepare('SELECT * FROM handoff_records WHERE id=?');
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  function previousRequest(actor, requestId, action, requestHash) {
    const previous = db.prepare('SELECT action,request_hash,handoff_id FROM handoff_requests WHERE actor=? AND request_id=?').get(actor, requestId);
    if (!previous) return null;
    if (previous.action !== action || previous.request_hash !== requestHash) fail('CONFLICT');
    return { record: record(recordById.get(previous.handoff_id)), duplicate: true };
  }
  function saveRequest(actor, requestId, action, requestHash, handoffId) {
    db.prepare('INSERT INTO handoff_requests(actor,request_id,action,request_hash,handoff_id) VALUES(?,?,?,?,?)')
      .run(actor, requestId, action, requestHash, handoffId);
  }
  let closed = false;
  function ensureOpen() { if (closed) fail('INVALID_REQUEST'); }

  return {
    propose(input) {
      ensureOpen();
      exactObject(input, ['actor', 'requestId', 'source', 'targetCardId', 'snapshot', 'now']);
      const actor = safeId(input.actor), requestId = safeId(input.requestId), targetCardId = safeId(input.targetCardId);
      const source = normalizeSource(input.source, targetCardId), now = timestamp(input.now), snapshot = normalizeSnapshot(input.snapshot);
      const requestHash = hash(JSON.stringify({ action: 'propose', source, targetCardId }));
      return transaction(() => {
        const previous = previousRequest(actor, requestId, 'propose', requestHash);
        if (previous) return previous;
        const id = randomUUID(), payloadHash = requestHash;
        db.prepare(`INSERT INTO handoff_records(id,owner,request_id,payload_hash,source_json,target_card_id,snapshot_json,state,created_at,accepted_at)
          VALUES(?,?,?,?,?,?,?,'pending',?,NULL)`)
          .run(id, actor, requestId, payloadHash, JSON.stringify(source), targetCardId,
            JSON.stringify({ text: snapshot.text, sha256: snapshot.sha256 }), now);
        saveRequest(actor, requestId, 'propose', requestHash, id);
        return { record: record(recordById.get(id)), duplicate: false };
      });
    },
    get(input) {
      ensureOpen();
      exactObject(input, ['actor', 'id']);
      const actor = safeId(input.actor), id = safeId(input.id);
      const row = db.prepare('SELECT * FROM handoff_records WHERE owner=? AND id=?').get(actor, id);
      return record(row);
    },
    list(input) {
      ensureOpen();
      exactObject(input, ['actor', 'targetCardId'], ['limit', 'offset']);
      const actor = safeId(input.actor), targetCardId = safeId(input.targetCardId);
      const limit = input.limit === undefined ? 20 : input.limit;
      const offset = input.offset === undefined ? 0 : input.offset;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail('INVALID_REQUEST');
      return db.prepare('SELECT * FROM handoff_records WHERE owner=? AND target_card_id=? ORDER BY created_at,id LIMIT ? OFFSET ?')
        .all(actor, targetCardId, limit, offset).map(record);
    },
    accept(input) {
      ensureOpen();
      exactObject(input, ['actor', 'id', 'requestId', 'now']);
      const actor = safeId(input.actor), id = safeId(input.id), requestId = safeId(input.requestId), now = timestamp(input.now);
      const requestHash = hash(JSON.stringify({ action: 'accept', id }));
      return transaction(() => {
        const previous = previousRequest(actor, requestId, 'accept', requestHash);
        if (previous) return previous;
        const row = db.prepare('SELECT * FROM handoff_records WHERE owner=? AND id=?').get(actor, id);
        if (!row) fail('NOT_FOUND');
        const duplicate = row.state === 'accepted';
        if (!duplicate) db.prepare("UPDATE handoff_records SET state='accepted',accepted_at=? WHERE id=? AND owner=? AND state='pending'").run(now, id, actor);
        saveRequest(actor, requestId, 'accept', requestHash, id);
        return { record: record(recordById.get(id)), duplicate };
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
