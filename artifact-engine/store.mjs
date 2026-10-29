import { DatabaseSync } from 'node:sqlite';

const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const artifactView = (db, id) => {
  const row = db.prepare('SELECT a.id,a.current_version,a.created_at,a.updated_at,v.title,v.format FROM artifacts a JOIN versions v ON v.artifact_id=a.id AND v.version=a.current_version WHERE a.id=?').get(id);
  return row && { id: row.id, title: row.title, format: row.format, currentVersion: row.current_version, createdAt: row.created_at, updatedAt: row.updated_at };
};
const versionView = row => row && ({ artifactId: row.artifact_id, version: row.version, title: row.title, format: row.format,
  content: row.content, contentHash: row.content_hash, sources: JSON.parse(row.sources), origin: JSON.parse(row.origin), createdAt: row.created_at });

export function openArtifactStore(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS artifacts(
      id TEXT PRIMARY KEY, current_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(
      artifact_id TEXT NOT NULL REFERENCES artifacts(id), version INTEGER NOT NULL, title TEXT NOT NULL,
      format TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, sources TEXT NOT NULL,
      origin TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(artifact_id,version));
    CREATE TABLE IF NOT EXISTS requests(
      key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL,
      artifact_id TEXT NOT NULL, version INTEGER NOT NULL);`);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function get(artifactId, version) {
    const selected = version ?? db.prepare('SELECT current_version AS version FROM artifacts WHERE id=?').get(artifactId)?.version;
    if (selected === undefined) throw bad('ARTIFACT_NOT_FOUND', 404);
    const row = db.prepare('SELECT * FROM versions WHERE artifact_id=? AND version=?').get(artifactId, selected);
    if (!row) throw bad('ARTIFACT_VERSION_NOT_FOUND', 404);
    return { artifact: artifactView(db, artifactId), version: versionView(row) };
  }
  function replay(key, operation, requestHash) {
    const row = db.prepare('SELECT * FROM requests WHERE key=?').get(key);
    if (!row) return null;
    if (row.operation !== operation || row.request_hash !== requestHash) throw bad('IDEMPOTENCY_CONFLICT', 409);
    return { ...get(row.artifact_id, row.version), idempotent: true };
  }
  function recordRequest(key, operation, requestHash, artifactId, version) {
    db.prepare('INSERT INTO requests(key,operation,request_hash,artifact_id,version) VALUES(?,?,?,?,?)')
      .run(key, operation, requestHash, artifactId, version);
  }
  function insertVersion(input, version) {
    db.prepare('INSERT INTO versions(artifact_id,version,title,format,content,content_hash,sources,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(input.artifactId, version, input.title, input.format, input.content, input.contentHash,
        JSON.stringify(input.sources), JSON.stringify(input.origin), now());
    db.prepare('UPDATE artifacts SET current_version=?,updated_at=? WHERE id=?').run(version, now(), input.artifactId);
    recordRequest(input.idempotencyKey, input.operation, input.requestHash, input.artifactId, version);
    return get(input.artifactId, version);
  }
  return {
    get,
    list(limit = 100) {
      return db.prepare('SELECT id FROM artifacts ORDER BY updated_at DESC,rowid DESC LIMIT ?').all(limit)
        .map(row => artifactView(db, row.id));
    },
    versions(artifactId) {
      if (!artifactView(db, artifactId)) throw bad('ARTIFACT_NOT_FOUND', 404);
      return db.prepare('SELECT * FROM versions WHERE artifact_id=? ORDER BY version DESC').all(artifactId).map(versionView);
    },
    create(input) {
      return transaction(() => {
        const previous = replay(input.idempotencyKey, 'create', input.requestHash);
        if (previous) return previous;
        if (artifactView(db, input.artifactId)) throw bad('ARTIFACT_EXISTS', 409);
        const timestamp = now();
        db.prepare('INSERT INTO artifacts(id,current_version,created_at,updated_at) VALUES(?,0,?,?)').run(input.artifactId, timestamp, timestamp);
        return insertVersion({ ...input, operation: 'create' }, 1);
      });
    },
    append(input) {
      return transaction(() => {
        const previous = replay(input.idempotencyKey, 'append', input.requestHash);
        if (previous) return previous;
        const artifact = artifactView(db, input.artifactId);
        if (!artifact) throw bad('ARTIFACT_NOT_FOUND', 404);
        if (artifact.currentVersion !== input.expectedVersion) throw bad('VERSION_CONFLICT', 409);
        return insertVersion({ ...input, operation: 'append' }, input.expectedVersion + 1);
      });
    },
    rollback(input) {
      return transaction(() => {
        const previous = replay(input.idempotencyKey, 'rollback', input.requestHash);
        if (previous) return previous;
        const current = get(input.artifactId);
        const target = get(input.artifactId, input.targetVersion).version;
        return insertVersion({ ...target, artifactId: input.artifactId, origin: input.origin,
          idempotencyKey: input.idempotencyKey, operation: 'rollback', requestHash: input.requestHash }, current.artifact.currentVersion + 1);
      });
    },
    close() { db.close(); },
  };
}
