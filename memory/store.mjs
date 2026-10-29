import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const valid = value => typeof value === 'string' && ID.test(value);
const content = value => { if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 64 * 1024) throw bad('INVALID_MEMORY_CONTENT'); return value; };
const view = (row, includeContent = true) => row && Object.freeze({ id: row.id, owner: row.owner, requestId: row.request_id,
  targetId: row.target_id, baseRevision: row.base_revision, worktree: row.worktree, branch: row.branch,
  state: row.state, revision: row.revision, reviewer: row.reviewer, reviewNote: row.review_note,
  promotionTicket: row.promotion_ticket, receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
  createdAt: row.created_at, updatedAt: row.updated_at, ...(includeContent ? { content: row.content } : {}) });

export function openMemoryStore(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS memory_targets(target_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_proposals(
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, target_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL, content TEXT NOT NULL, worktree TEXT NOT NULL, branch TEXT NOT NULL,
      state TEXT NOT NULL, revision INTEGER NOT NULL, reviewer TEXT, review_note TEXT,
      promotion_ticket TEXT, receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(owner,request_id));`);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const get = id => view(db.prepare('SELECT * FROM memory_proposals WHERE id=?').get(id));
  return {
    propose(input) {
      if (![input?.owner, input?.requestId, input?.targetId].every(valid) || !Number.isSafeInteger(input?.baseRevision) || input.baseRevision < 1 ||
          !BRANCH.test(input?.branch ?? '') || input.branch.includes('..') || input.branch.includes('//')) throw bad('INVALID_MEMORY_PROPOSAL');
      if (typeof input.worktree !== 'string' || !isAbsolute(input.worktree) || input.worktree.includes('\0')) throw bad('INVALID_MEMORY_LOCATION');
      const body = content(input.content);
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM memory_proposals WHERE owner=? AND request_id=?').get(input.owner, input.requestId);
        if (existing) {
          if (existing.target_id !== input.targetId || existing.base_revision !== input.baseRevision || existing.content !== body ||
              existing.worktree !== input.worktree || existing.branch !== input.branch) throw bad('MEMORY_REQUEST_CONFLICT', 409);
          return { proposal: view(existing), duplicate: true };
        }
        db.prepare('INSERT OR IGNORE INTO memory_targets(target_id,revision) VALUES(?,?)').run(input.targetId, input.baseRevision);
        const id = randomUUID(), timestamp = now();
        db.prepare("INSERT INTO memory_proposals(id,owner,request_id,target_id,base_revision,content,worktree,branch,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'PROPOSED',1,?,?)")
          .run(id, input.owner, input.requestId, input.targetId, input.baseRevision, body, input.worktree, input.branch, timestamp, timestamp);
        return { proposal: get(id), duplicate: false };
      });
    },
    get(id) { if (!valid(id)) throw bad('INVALID_MEMORY_PROPOSAL'); return get(id); },
    list() { return db.prepare('SELECT * FROM memory_proposals ORDER BY created_at,id LIMIT 100').all().map(row => view(row, false)); },
    review(id, input) {
      if (!valid(id) || !valid(input?.reviewer) || !Number.isSafeInteger(input?.expectedRevision) || !['APPROVED', 'REJECTED'].includes(input?.decision) ||
          (input.note !== undefined && (typeof input.note !== 'string' || Buffer.byteLength(input.note) > 2048))) throw bad('INVALID_MEMORY_REVIEW');
      return transaction(() => {
        const current = get(id); if (!current) throw bad('MEMORY_PROPOSAL_NOT_FOUND', 404);
        if (current.revision !== input.expectedRevision) throw bad('MEMORY_REVIEW_CONFLICT', 409);
        if (current.reviewer !== null || current.state !== 'PROPOSED') throw bad('MEMORY_STATE_CONFLICT', 409);
        if (current.owner === input.reviewer) throw bad('MEMORY_REVIEWER_REQUIRED', 409);
        db.prepare('UPDATE memory_proposals SET state=?,reviewer=?,review_note=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
          .run(input.decision, input.reviewer, input.note ?? null, now(), id, input.expectedRevision);
        return get(id);
      });
    },
    beginPromotion(id) {
      if (!valid(id)) throw bad('INVALID_MEMORY_PROPOSAL');
      return transaction(() => {
        const current = get(id); if (!current) throw bad('MEMORY_PROPOSAL_NOT_FOUND', 404);
        if (current.state !== 'APPROVED') throw bad('MEMORY_PROMOTION_NOT_APPROVED', 409);
        const target = db.prepare('SELECT revision FROM memory_targets WHERE target_id=?').get(current.targetId);
        if (!target || target.revision !== current.baseRevision) {
          db.prepare("UPDATE memory_proposals SET state='CONFLICT',revision=revision+1,updated_at=? WHERE id=?").run(now(), id);
          return { proposal: get(id), conflict: true };
        }
        db.prepare("UPDATE memory_proposals SET state='PROMOTING',revision=revision+1,updated_at=? WHERE id=? AND state='APPROVED'").run(now(), id);
        return { proposal: get(id), conflict: false };
      });
    },
    completePromotion(id, ticket, receipt) {
      if (!valid(id) || !valid(ticket) || !receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Buffer.byteLength(JSON.stringify(receipt)) > 4096) throw bad('INVALID_MEMORY_RECEIPT');
      return transaction(() => {
        const current = get(id); if (!current || current.state !== 'PROMOTING') throw bad('MEMORY_STATE_CONFLICT', 409);
        const target = db.prepare('SELECT revision FROM memory_targets WHERE target_id=?').get(current.targetId);
        if (!target || target.revision !== current.baseRevision) throw bad('MEMORY_PROMOTION_CONFLICT', 409);
        db.prepare('UPDATE memory_targets SET revision=revision+1 WHERE target_id=? AND revision=?').run(current.targetId, current.baseRevision);
        db.prepare("UPDATE memory_proposals SET state='PROMOTED',promotion_ticket=?,receipt_json=?,revision=revision+1,updated_at=? WHERE id=? AND state='PROMOTING'")
          .run(ticket, JSON.stringify(receipt), now(), id);
        return get(id);
      });
    },
    unknownPromotion(id) {
      if (!valid(id)) throw bad('INVALID_MEMORY_PROPOSAL');
      return transaction(() => {
        const current = get(id); if (!current) throw bad('MEMORY_PROPOSAL_NOT_FOUND', 404);
        if (current.state === 'PROMOTING') db.prepare("UPDATE memory_proposals SET state='PROMOTION_UNKNOWN',revision=revision+1,updated_at=? WHERE id=?").run(now(), id);
        return get(id);
      });
    },
    recoverPromotions() {
      return transaction(() => {
        const rows = db.prepare("SELECT id FROM memory_proposals WHERE state='PROMOTING'").all();
        for (const row of rows) db.prepare("UPDATE memory_proposals SET state='PROMOTION_UNKNOWN',revision=revision+1,updated_at=? WHERE id=?").run(now(), row.id);
        return rows.length;
      });
    },
    close() { db.close(); },
  };
}
