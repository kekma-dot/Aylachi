import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const valid = value => typeof value === 'string' && ID.test(value);
const view = row => row && Object.freeze({ cardId: row.card_id, backendId: row.backend_id, backendRevision: row.backend_revision,
  sessionId: row.session_id, createdAt: row.created_at });

export function openBackendStore(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS backend_conversations(
    card_id TEXT PRIMARY KEY, backend_id TEXT NOT NULL, backend_revision INTEGER NOT NULL,
    session_id TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  return {
    bind({ cardId, backendId, backendRevision, sessionId }) {
      if (![cardId, backendId, sessionId].every(valid) || !Number.isSafeInteger(backendRevision) || backendRevision < 1) throw bad('INVALID_BACKEND_BINDING');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT * FROM backend_conversations WHERE card_id=?').get(cardId);
        if (existing) {
          if (existing.backend_id !== backendId || existing.backend_revision !== backendRevision || existing.session_id !== sessionId) throw bad('BACKEND_BINDING_CONFLICT', 409);
          db.exec('COMMIT'); return { ...view(existing), idempotent: true };
        }
        db.prepare('INSERT INTO backend_conversations(card_id,backend_id,backend_revision,session_id,created_at) VALUES(?,?,?,?,?)')
          .run(cardId, backendId, backendRevision, sessionId, now());
        db.exec('COMMIT');
        return view(db.prepare('SELECT * FROM backend_conversations WHERE card_id=?').get(cardId));
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    get(cardId) { if (!valid(cardId)) throw bad('INVALID_CARD_ID'); return view(db.prepare('SELECT * FROM backend_conversations WHERE card_id=?').get(cardId)); },
    close() { db.close(); },
  };
}
