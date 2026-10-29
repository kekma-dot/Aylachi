import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { snapshotThemeTokens } from './schema.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const id = value => { if (typeof value !== 'string' || !ID.test(value)) throw bad('INVALID_ID'); return value; };
const name = value => { if (typeof value !== 'string' || !value.trim() || value.length > 120) throw bad('INVALID_THEME_NAME'); return value.trim(); };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) throw bad('REVISION_CONFLICT', 409); return value; };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function openThemeStore(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS themes(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,base TEXT NOT NULL,origin TEXT NOT NULL,state TEXT NOT NULL,
      current_version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS theme_versions(
      theme_id TEXT NOT NULL REFERENCES themes(id),version INTEGER NOT NULL,tokens TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(theme_id,version));
    CREATE TABLE IF NOT EXISTS workspace_themes(
      canvas_id TEXT PRIMARY KEY,theme_id TEXT REFERENCES themes(id),revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS theme_requests(
      key TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL);`);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const themeView = row => row && ({ id: row.id, name: row.name, base: row.base, origin: row.origin, state: row.state,
    currentVersion: row.current_version, createdAt: row.created_at, updatedAt: row.updated_at });
  const versionView = row => row && ({ themeId: row.theme_id, version: row.version, tokens: JSON.parse(row.tokens), createdAt: row.created_at });
  function get(themeId, version) {
    id(themeId);
    const theme = themeView(db.prepare('SELECT * FROM themes WHERE id=?').get(themeId));
    if (!theme) throw bad('THEME_NOT_FOUND', 404);
    const selected = version ?? theme.currentVersion;
    const record = versionView(db.prepare('SELECT * FROM theme_versions WHERE theme_id=? AND version=?').get(themeId, selected));
    if (!record) throw bad('THEME_VERSION_NOT_FOUND', 404);
    return { theme, version: record };
  }
  function ensureWorkspace(canvasId) {
    id(canvasId);
    db.prepare('INSERT OR IGNORE INTO workspace_themes(canvas_id,theme_id,revision,updated_at) VALUES(?,NULL,1,?)').run(canvasId, now());
    return db.prepare('SELECT * FROM workspace_themes WHERE canvas_id=?').get(canvasId);
  }
  function workspace(canvasId) {
    const row = ensureWorkspace(canvasId);
    const active = row.theme_id ? get(row.theme_id) : null;
    const themes = db.prepare('SELECT * FROM themes ORDER BY updated_at DESC,rowid DESC').all().map(themeView);
    return { canvasId, revision: row.revision, active,
      themes: themes.filter(theme => theme.state !== 'PROPOSED'), proposals: themes.filter(theme => theme.state === 'PROPOSED').map(theme => get(theme.id)) };
  }
  function setActive(canvasId, themeId, expectedRevision) {
    const row = ensureWorkspace(canvasId);
    if (row.revision !== revision(expectedRevision)) throw bad('REVISION_CONFLICT', 409);
    db.prepare('UPDATE workspace_themes SET theme_id=?,revision=revision+1,updated_at=? WHERE canvas_id=?').run(themeId, now(), canvasId);
  }
  function mutate(key, operation, payload, effect) {
    if (typeof key !== 'string' || key.length < 1 || key.length > 256) throw bad('INVALID_IDEMPOTENCY_KEY');
    const requestHash = hash(payload);
    return transaction(() => {
      const previous = db.prepare('SELECT * FROM theme_requests WHERE key=?').get(key);
      if (previous) {
        if (previous.operation !== operation || previous.request_hash !== requestHash) throw bad('IDEMPOTENCY_CONFLICT', 409);
        return { ...JSON.parse(previous.result), idempotent: true };
      }
      const result = effect();
      db.prepare('INSERT INTO theme_requests(key,operation,request_hash,result) VALUES(?,?,?,?)').run(key, operation, requestHash, JSON.stringify(result));
      return result;
    });
  }
  function insertVersion(themeId, tokens, version) {
    db.prepare('INSERT INTO theme_versions(theme_id,version,tokens,created_at) VALUES(?,?,?,?)').run(themeId, version, JSON.stringify(tokens), now());
    db.prepare('UPDATE themes SET base=?,current_version=?,updated_at=? WHERE id=?').run(tokens.base, version, now(), themeId);
    return get(themeId, version);
  }
  return {
    get, workspace,
    create(input) {
      const themeId = id(input.id), canvasId = id(input.canvasId), origin = input.origin;
      if (!['user', 'agent'].includes(origin)) throw bad('INVALID_THEME_ORIGIN');
      const themeName = name(input.name), tokens = snapshotThemeTokens({ ...input.tokens, base: input.base ?? input.tokens?.base });
      return mutate(input.idempotencyKey, 'create', { themeId, canvasId, origin, name: themeName, tokens, workspaceRevision: input.expectedWorkspaceRevision }, () => {
        if (themeView(db.prepare('SELECT * FROM themes WHERE id=?').get(themeId))) throw bad('THEME_EXISTS', 409);
        const timestamp = now();
        db.prepare('INSERT INTO themes(id,name,base,origin,state,current_version,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)')
          .run(themeId, themeName, tokens.base, origin, origin === 'agent' ? 'PROPOSED' : 'SAVED', timestamp, timestamp);
        insertVersion(themeId, tokens, 1);
        if (origin === 'user') setActive(canvasId, themeId, input.expectedWorkspaceRevision);
        return { ...get(themeId), workspace: workspace(canvasId) };
      });
    },
    append(input) {
      const themeId = id(input.themeId), canvasId = id(input.canvasId), tokens = snapshotThemeTokens({ ...input.tokens, base: input.base ?? input.tokens?.base });
      return mutate(input.idempotencyKey, 'append', { themeId, canvasId, tokens, expectedVersion: input.expectedVersion, workspaceRevision: input.expectedWorkspaceRevision }, () => {
        const current = get(themeId);
        if (current.theme.state !== 'SAVED' || current.theme.currentVersion !== revision(input.expectedVersion)) throw bad('REVISION_CONFLICT', 409);
        const result = insertVersion(themeId, tokens, current.theme.currentVersion + 1);
        setActive(canvasId, themeId, input.expectedWorkspaceRevision);
        return { ...result, workspace: workspace(canvasId) };
      });
    },
    activate(input) {
      const themeId = id(input.themeId), canvasId = id(input.canvasId);
      return mutate(input.idempotencyKey, 'activate', { themeId, canvasId, expectedVersion: input.expectedVersion, workspaceRevision: input.expectedWorkspaceRevision }, () => {
        const current = get(themeId);
        if (current.theme.state === 'REJECTED' || current.theme.currentVersion !== revision(input.expectedVersion)) throw bad('REVISION_CONFLICT', 409);
        if (current.theme.state === 'PROPOSED') db.prepare("UPDATE themes SET state='SAVED',updated_at=? WHERE id=?").run(now(), themeId);
        setActive(canvasId, themeId, input.expectedWorkspaceRevision);
        return { ...get(themeId), workspace: workspace(canvasId) };
      });
    },
    rollback(input) {
      const themeId = id(input.themeId), canvasId = id(input.canvasId);
      return mutate(input.idempotencyKey, 'rollback', { themeId, canvasId, targetVersion: input.targetVersion, expectedVersion: input.expectedVersion, workspaceRevision: input.expectedWorkspaceRevision }, () => {
        const current = get(themeId), target = get(themeId, revision(input.targetVersion));
        if (current.theme.state !== 'SAVED' || current.theme.currentVersion !== revision(input.expectedVersion)) throw bad('REVISION_CONFLICT', 409);
        const result = insertVersion(themeId, target.version.tokens, current.theme.currentVersion + 1);
        setActive(canvasId, themeId, input.expectedWorkspaceRevision);
        return { ...result, workspace: workspace(canvasId) };
      });
    },
    disable(input) {
      const canvasId = id(input.canvasId);
      return mutate(input.idempotencyKey, 'disable', { canvasId, workspaceRevision: input.expectedWorkspaceRevision }, () => {
        setActive(canvasId, null, input.expectedWorkspaceRevision);
        return { workspace: workspace(canvasId) };
      });
    },
    reject(input) {
      const themeId = id(input.themeId);
      return mutate(input.idempotencyKey, 'reject', { themeId, expectedVersion: input.expectedVersion }, () => {
        const current = get(themeId);
        if (current.theme.state !== 'PROPOSED' || current.theme.currentVersion !== revision(input.expectedVersion)) throw bad('REVISION_CONFLICT', 409);
        db.prepare("UPDATE themes SET state='REJECTED',updated_at=? WHERE id=?").run(now(), themeId);
        return get(themeId);
      });
    },
    close() { db.close(); },
  };
}
