import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_ID = 128;
const MAX_TEXT_BYTES = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATES = new Set(['RESERVED', 'DISPATCHED', 'NEEDS_RECONCILIATION', 'COMPLETED']);
const TRANSITIONS = new Set([
  'RESERVED>DISPATCHED', 'RESERVED>NEEDS_RECONCILIATION',
  'DISPATCHED>COMPLETED', 'DISPATCHED>NEEDS_RECONCILIATION',
  'NEEDS_RECONCILIATION>DISPATCHED', 'NEEDS_RECONCILIATION>COMPLETED',
]);
const STATUS = { INVALID_REQUEST: 400, TOO_LARGE: 413, CONFLICT: 409, NOT_FOUND: 404 };

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
function requestText(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REQUEST');
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) fail('TOO_LARGE');
  return value;
}
function resultValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST');
  const proto = Object.getPrototypeOf(value);
  const statusDescriptor = Object.getOwnPropertyDescriptor(value, 'status');
  if ((proto !== Object.prototype && proto !== null) || !statusDescriptor?.enumerable || !('value' in statusDescriptor)) fail('INVALID_REQUEST');
  if (statusDescriptor.value === 'ok') {
    exactObject(value, ['status', 'text']);
    if (typeof value.text !== 'string') fail('INVALID_REQUEST');
    if (Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES) fail('TOO_LARGE');
    return { status: 'ok', text: value.text };
  }
  if (statusDescriptor.value === 'cancelled') {
    exactObject(value, ['status']);
    return { status: 'cancelled' };
  }
  if (statusDescriptor.value === 'error') {
    exactObject(value, ['status', 'code']);
    if (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)) fail('INVALID_REQUEST');
    return { status: 'error', code: value.code };
  }
  fail('INVALID_REQUEST');
}
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
function record(row) {
  return row && {
    id: row.id,
    actor: row.actor,
    requestId: row.request_id,
    parentCommandId: row.parent_command_id,
    parentCardId: row.parent_card_id,
    canvasId: row.canvas_id,
    text: row.text,
    childCardId: row.child_card_id,
    childSessionId: row.child_session_id,
    leaseId: row.lease_id,
    childCommandId: row.child_command_id,
    cancelRequestId: row.cancel_request_id,
    state: row.state,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function generatedIds() {
  let id, leaseId;
  do { id = randomUUID(); leaseId = randomUUID(); } while (id === leaseId);
  return {
    id,
    childCardId: `child-${randomUUID()}`,
    childSessionId: `session-${randomUUID()}`,
    leaseId,
    childCommandId: `delegate-${randomUUID()}`,
    cancelRequestId: `cancel-${randomUUID()}`,
  };
}

export function openDelegationStore(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) fail('INVALID_REQUEST');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS delegation_records (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      parent_command_id TEXT NOT NULL,
      parent_card_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      text TEXT NOT NULL,
      child_card_id TEXT NOT NULL UNIQUE,
      child_session_id TEXT NOT NULL UNIQUE,
      lease_id TEXT NOT NULL UNIQUE,
      child_command_id TEXT NOT NULL UNIQUE,
      cancel_request_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCHED','NEEDS_RECONCILIATION','COMPLETED')),
      result_json TEXT,
      created_at INTEGER NOT NULL CHECK(created_at >= 0),
      updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
      last_expected_state TEXT,
      UNIQUE(actor, request_id)
    );`);

  const byId = db.prepare('SELECT * FROM delegation_records WHERE actor=? AND id=?');
  const byRequest = db.prepare('SELECT * FROM delegation_records WHERE actor=? AND request_id=?');
  function ensureOpen() { if (closed) fail('INVALID_REQUEST'); }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  let closed = false;
  return {
    reserve(input) {
      ensureOpen();
      exactObject(input, ['actor', 'requestId', 'parentCommandId', 'parentCardId', 'canvasId', 'text', 'now']);
      const actor = safeId(input.actor), requestId = safeId(input.requestId);
      const parentCommandId = safeId(input.parentCommandId), parentCardId = safeId(input.parentCardId), canvasId = safeId(input.canvasId);
      const text = requestText(input.text), now = timestamp(input.now);
      const requestHash = hash(JSON.stringify({ parentCommandId, parentCardId, canvasId, text }));
      return transaction(() => {
        const previous = byRequest.get(actor, requestId);
        if (previous) {
          if (previous.request_hash !== requestHash) fail('CONFLICT');
          return { record: record(previous), duplicate: true };
        }
        const ids = generatedIds();
        const allIds = Object.values(ids);
        if (new Set(allIds).size !== allIds.length) throw new Error('UUID_COLLISION');
        db.prepare(`INSERT INTO delegation_records(
          id,actor,request_id,request_hash,parent_command_id,parent_card_id,canvas_id,text,
          child_card_id,child_session_id,lease_id,child_command_id,cancel_request_id,
          state,result_json,created_at,updated_at,last_expected_state
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'RESERVED',NULL,?,?,NULL)`)
          .run(ids.id,actor,requestId,requestHash,parentCommandId,parentCardId,canvasId,text,
            ids.childCardId,ids.childSessionId,ids.leaseId,ids.childCommandId,ids.cancelRequestId,now,now);
        return { record: record(byId.get(actor, ids.id)), duplicate: false };
      });
    },
    get(input) {
      ensureOpen(); exactObject(input, ['actor', 'id']);
      const actor = safeId(input.actor), id = safeId(input.id);
      return record(byId.get(actor, id)) ?? null;
    },
    findRequest(input) {
      ensureOpen(); exactObject(input, ['actor', 'requestId']);
      const actor = safeId(input.actor), requestId = safeId(input.requestId);
      return record(byRequest.get(actor, requestId)) ?? null;
    },
    transition(input) {
      ensureOpen(); exactObject(input, ['actor', 'id', 'expectedState', 'nextState', 'now'], ['result']);
      const actor = safeId(input.actor), id = safeId(input.id);
      const expectedState = input.expectedState, nextState = input.nextState;
      if (!STATES.has(expectedState) || !STATES.has(nextState) || !TRANSITIONS.has(`${expectedState}>${nextState}`)) fail('INVALID_REQUEST');
      const hasResult = Object.hasOwn(input, 'result');
      if (nextState === 'COMPLETED' ? !hasResult : hasResult) fail('INVALID_REQUEST');
      const result = hasResult ? resultValue(input.result) : null;
      const resultJson = result === null ? null : JSON.stringify(result);
      const now = timestamp(input.now);
      return transaction(() => {
        const current = byId.get(actor, id);
        if (!current) fail('NOT_FOUND');
        if (now < current.updated_at) fail('INVALID_REQUEST');
        if (current.state === expectedState) {
          db.prepare(`UPDATE delegation_records SET state=?,result_json=?,updated_at=?,last_expected_state=?
            WHERE actor=? AND id=? AND state=?`).run(nextState,resultJson,now,expectedState,actor,id,expectedState);
          return record(byId.get(actor, id));
        }
        if (current.state === nextState && current.last_expected_state === expectedState && current.result_json === resultJson)
          return record(current);
        fail('CONFLICT');
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
