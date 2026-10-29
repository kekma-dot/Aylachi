import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STATES = new Set(['PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'UNKNOWN', 'SUCCEEDED', 'FAILED']);
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_REQUEST');
  const keys = Reflect.ownKeys(value), allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('INVALID_REQUEST');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_REQUEST');
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail('INVALID_REQUEST');
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_REQUEST'); return value; }
function now(value) { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_REQUEST'); return value; }
function payloadHash(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_REQUEST'); return value; }
function receipt(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 64 * 1024) fail('TOO_LARGE');
  return encoded;
}
function effect(row) {
  return row && Object.freeze({
    id: row.id, actor: row.actor, requestId: row.request_id, parentCommandId: row.parent_command_id,
    parentCardId: row.parent_card_id, canvasId: row.canvas_id, toolName: row.tool_name, text: row.text,
    payloadHash: row.payload_hash, attempt: row.attempt, ownerId: row.owner_id, state: row.state,
    reasonCode: row.reason_code, receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

// Journal for effects whose dispatch is owned by this Hub. UNKNOWN is never a
// success/failure and can only be resolved by an authoritative read receipt.
export function openToolEffectStore(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) fail('INVALID_REQUEST');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tool_effects (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, request_id TEXT NOT NULL,
      parent_command_id TEXT NOT NULL, parent_card_id TEXT NOT NULL, canvas_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, text TEXT NOT NULL, payload_hash TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1), owner_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('PENDING_APPROVAL','APPROVED','RUNNING','UNKNOWN','SUCCEEDED','FAILED')),
      reason_code TEXT, receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(actor, request_id)
    );`);
  const byId = db.prepare('SELECT * FROM tool_effects WHERE actor=? AND id=?');
  const byRequest = db.prepare('SELECT * FROM tool_effects WHERE actor=? AND request_id=?');
  let closed = false;
  function transaction(fn) {
    if (closed) fail('INVALID_REQUEST');
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  function current(actor, effectId) { const row = byId.get(actor, effectId); if (!row) fail('NOT_FOUND'); return row; }
  function match(row, attempt, expectedHash) {
    if (row.attempt !== attempt || row.payload_hash !== expectedHash) fail('EFFECT_CONFLICT');
  }
  return {
    reserve(input) {
      exact(input, ['actor', 'requestId', 'parentCommandId', 'parentCardId', 'canvasId', 'toolName', 'text', 'requiresApproval', 'now']);
      const actor = id(input.actor), requestId = id(input.requestId), parentCommandId = id(input.parentCommandId);
      const parentCardId = id(input.parentCardId), canvasId = id(input.canvasId), toolName = id(input.toolName);
      if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 16 * 1024 || typeof input.requiresApproval !== 'boolean') fail('INVALID_REQUEST');
      const createdAt = now(input.now);
      const payload = JSON.stringify({ parentCommandId, parentCardId, canvasId, requestId, toolName, text: input.text });
      const payloadHash = hash(payload), effectId = `effect-${hash(`${actor}\0${requestId}`)}`;
      return transaction(() => {
        const previous = byRequest.get(actor, requestId);
        if (previous) {
          if (previous.payload_hash !== payloadHash) fail('EFFECT_CONFLICT');
          return { effect: effect(previous), duplicate: true };
        }
        db.prepare(`INSERT INTO tool_effects(id,actor,request_id,parent_command_id,parent_card_id,canvas_id,tool_name,text,payload_hash,attempt,owner_id,state,reason_code,receipt_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,1,NULL,?,NULL,NULL,?,?)`).run(effectId, actor, requestId, parentCommandId, parentCardId, canvasId, toolName, input.text, payloadHash,
          input.requiresApproval ? 'PENDING_APPROVAL' : 'APPROVED', createdAt, createdAt);
        return { effect: effect(byId.get(actor, effectId)), duplicate: false };
      });
    },
    get(input) { exact(input, ['actor', 'id']); return effect(byId.get(id(input.actor), id(input.id))) ?? null; },
    findRequest(input) { exact(input, ['actor', 'requestId']); return effect(byRequest.get(id(input.actor), id(input.requestId))) ?? null; },
    approve(input) {
      exact(input, ['actor', 'id', 'attempt', 'payloadHash', 'now']);
      const actor = id(input.actor), effectId = id(input.id), attempt = input.attempt, expectedHash = payloadHash(input.payloadHash), updatedAt = now(input.now);
      if (!Number.isSafeInteger(attempt) || attempt < 1) fail('INVALID_REQUEST');
      return transaction(() => {
        const row = current(actor, effectId); match(row, attempt, expectedHash);
        if (row.state === 'PENDING_APPROVAL') db.prepare("UPDATE tool_effects SET state='APPROVED',updated_at=? WHERE actor=? AND id=? AND state='PENDING_APPROVAL'").run(updatedAt, actor, effectId);
        else if (!['APPROVED', 'RUNNING', 'SUCCEEDED'].includes(row.state)) fail('EFFECT_CONFLICT');
        return effect(byId.get(actor, effectId));
      });
    },
    begin(input) {
      exact(input, ['actor', 'id', 'attempt', 'payloadHash', 'ownerId', 'now']);
      const actor = id(input.actor), effectId = id(input.id), ownerId = id(input.ownerId), attempt = input.attempt, expectedHash = payloadHash(input.payloadHash), updatedAt = now(input.now);
      if (!Number.isSafeInteger(attempt) || attempt < 1) fail('INVALID_REQUEST');
      return transaction(() => {
        const row = current(actor, effectId); match(row, attempt, expectedHash);
        if (row.state === 'APPROVED') db.prepare("UPDATE tool_effects SET state='RUNNING',owner_id=?,updated_at=? WHERE actor=? AND id=? AND state='APPROVED'").run(ownerId, updatedAt, actor, effectId);
        else if (row.state !== 'RUNNING' || row.owner_id !== ownerId) fail('EFFECT_CONFLICT');
        return effect(byId.get(actor, effectId));
      });
    },
    complete(input) {
      exact(input, ['actor', 'id', 'attempt', 'ownerId', 'state', 'now'], ['receipt', 'reasonCode']);
      const actor = id(input.actor), effectId = id(input.id), ownerId = id(input.ownerId), attempt = input.attempt, updatedAt = now(input.now);
      if (!Number.isSafeInteger(attempt) || attempt < 1 || !['SUCCEEDED', 'FAILED'].includes(input.state)) fail('INVALID_REQUEST');
      if (input.state === 'SUCCEEDED' ? !Object.hasOwn(input, 'receipt') : typeof input.reasonCode !== 'string' || !CODE.test(input.reasonCode)) fail('INVALID_REQUEST');
      const encoded = input.state === 'SUCCEEDED' ? receipt(input.receipt) : null;
      return transaction(() => {
        const row = current(actor, effectId);
        if (row.attempt !== attempt || row.owner_id !== ownerId) fail('EFFECT_CONFLICT');
        if (row.state === 'RUNNING') db.prepare('UPDATE tool_effects SET state=?,reason_code=?,receipt_json=?,updated_at=? WHERE actor=? AND id=? AND state=\'RUNNING\' AND owner_id=?')
          .run(input.state, input.reasonCode ?? null, encoded, updatedAt, actor, effectId, ownerId);
        else if (row.state !== input.state || row.receipt_json !== encoded || (row.reason_code ?? null) !== (input.reasonCode ?? null)) fail('EFFECT_CONFLICT');
        return effect(byId.get(actor, effectId));
      });
    },
    markUnknown(input) {
      exact(input, ['actor', 'id', 'attempt', 'ownerId', 'reasonCode', 'now']);
      const actor = id(input.actor), effectId = id(input.id), ownerId = id(input.ownerId), attempt = input.attempt, updatedAt = now(input.now);
      if (!Number.isSafeInteger(attempt) || attempt < 1 || typeof input.reasonCode !== 'string' || !CODE.test(input.reasonCode)) fail('INVALID_REQUEST');
      return transaction(() => {
        const row = current(actor, effectId);
        if (row.attempt !== attempt || row.owner_id !== ownerId) fail('EFFECT_CONFLICT');
        if (row.state === 'RUNNING') db.prepare("UPDATE tool_effects SET state='UNKNOWN',reason_code=?,updated_at=? WHERE actor=? AND id=? AND state='RUNNING' AND owner_id=?").run(input.reasonCode, updatedAt, actor, effectId, ownerId);
        else if (row.state !== 'UNKNOWN') fail('EFFECT_CONFLICT');
        return effect(byId.get(actor, effectId));
      });
    },
    reconcile(input) {
      exact(input, ['actor', 'id', 'attempt', 'payloadHash', 'receipt', 'now']);
      const actor = id(input.actor), effectId = id(input.id), attempt = input.attempt, expectedHash = payloadHash(input.payloadHash), encoded = receipt(input.receipt), updatedAt = now(input.now);
      if (!Number.isSafeInteger(attempt) || attempt < 1) fail('INVALID_REQUEST');
      return transaction(() => {
        const row = current(actor, effectId); match(row, attempt, expectedHash);
        if (row.state === 'UNKNOWN') db.prepare("UPDATE tool_effects SET state='SUCCEEDED',reason_code=NULL,receipt_json=?,updated_at=? WHERE actor=? AND id=? AND state='UNKNOWN'").run(encoded, updatedAt, actor, effectId);
        else if (row.state !== 'SUCCEEDED' || row.receipt_json !== encoded) fail('EFFECT_CONFLICT');
        return effect(byId.get(actor, effectId));
      });
    },
    recoverRunning(input) {
      exact(input, ['now']); const updatedAt = now(input.now);
      return transaction(() => {
        const rows = db.prepare("SELECT * FROM tool_effects WHERE state='RUNNING'").all();
        db.prepare("UPDATE tool_effects SET state='UNKNOWN',reason_code='OWNER_RESTARTED',updated_at=? WHERE state='RUNNING'").run(updatedAt);
        return rows.map(row => effect({ ...row, state: 'UNKNOWN', reason_code: 'OWNER_RESTARTED', updated_at: updatedAt }));
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
