import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });
const id = value => { if (typeof value !== 'string' || !ID.test(value)) throw bad('INVALID_ID'); return value; };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) throw bad('REVISION_CONFLICT', 409); return value; };
const text = (value, max) => { if (typeof value !== 'string' || Buffer.byteLength(value) > max) throw bad('INVALID_BROWSER_RECORD'); return value; };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function openBrowserStore(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS browser_sessions(
      id TEXT PRIMARY KEY,canvas_id TEXT NOT NULL,mode TEXT NOT NULL,backend_id TEXT NOT NULL,policy TEXT NOT NULL,
      active_tab_id TEXT,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS browser_tabs(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES browser_sessions(id),url TEXT NOT NULL,title TEXT NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS browser_snapshots(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES browser_sessions(id),tab_id TEXT NOT NULL REFERENCES browser_tabs(id),
      url TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,links TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS browser_requests(
      key TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL);`);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const sessionView = row => row && ({ id: row.id, canvasId: row.canvas_id, mode: row.mode, backendId: row.backend_id,
    policy: JSON.parse(row.policy), activeTabId: row.active_tab_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });
  const tabView = row => row && ({ id: row.id, sessionId: row.session_id, url: row.url, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at });
  const snapshotView = row => row && ({ id: row.id, sessionId: row.session_id, tabId: row.tab_id, url: row.url, title: row.title,
    text: row.text, links: JSON.parse(row.links), createdAt: row.created_at });
  function getSession(sessionId) {
    const session = sessionView(db.prepare('SELECT * FROM browser_sessions WHERE id=?').get(id(sessionId)));
    if (!session) throw bad('BROWSER_SESSION_NOT_FOUND', 404);
    return session;
  }
  function getTab(tabId, sessionId) {
    const tab = tabView(db.prepare('SELECT * FROM browser_tabs WHERE id=?').get(id(tabId)));
    if (!tab || sessionId !== undefined && tab.sessionId !== sessionId) throw bad('BROWSER_TAB_NOT_FOUND', 404);
    return tab;
  }
  function result(sessionId, tabId, snapshotId) {
    const session = getSession(sessionId);
    return { session, tabs: db.prepare('SELECT * FROM browser_tabs WHERE session_id=? ORDER BY rowid').all(sessionId).map(tabView),
      ...(tabId ? { tab: getTab(tabId, sessionId) } : {}),
      ...(snapshotId ? { snapshot: snapshotView(db.prepare('SELECT * FROM browser_snapshots WHERE id=?').get(snapshotId)) } : {}) };
  }
  function replay(key, operation, payload) {
    const row = db.prepare('SELECT * FROM browser_requests WHERE key=?').get(key);
    if (!row) return null;
    if (row.operation !== operation || row.request_hash !== hash(payload)) throw bad('IDEMPOTENCY_CONFLICT', 409);
    return { ...JSON.parse(row.result), idempotent: true };
  }
  function mutate(key, operation, payload, effect) {
    if (typeof key !== 'string' || !key.length || key.length > 256) throw bad('INVALID_IDEMPOTENCY_KEY');
    return transaction(() => {
      const previous = replay(key, operation, payload);
      if (previous) return previous;
      const value = effect();
      db.prepare('INSERT INTO browser_requests(key,operation,request_hash,result) VALUES(?,?,?,?)').run(key, operation, hash(payload), JSON.stringify(value));
      return value;
    });
  }
  function snapshotInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('INVALID_BROWSER_SNAPSHOT');
    const links = input.links ?? [];
    if (!Array.isArray(links) || links.length > 32 || links.some(link => !link || typeof link.text !== 'string' || typeof link.href !== 'string' ||
        Buffer.byteLength(link.text) > 240 || Buffer.byteLength(link.href) > 2048)) throw bad('INVALID_BROWSER_SNAPSHOT');
    return { id: id(input.id), url: text(input.url, 2048), title: text(input.title, 240), text: text(input.text, 32768), links };
  }
  function insertSnapshot(sessionId, tabId, input) {
    db.prepare('INSERT INTO browser_snapshots(id,session_id,tab_id,url,title,text,links,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(input.id, sessionId, tabId, input.url, input.title, input.text, JSON.stringify(input.links), now());
    db.prepare('UPDATE browser_tabs SET url=?,title=?,updated_at=? WHERE id=?').run(input.url, input.title, now(), tabId);
  }
  function bump(sessionId, tabId, expectedRevision) {
    const session = getSession(sessionId);
    if (session.revision !== revision(expectedRevision)) throw bad('REVISION_CONFLICT', 409);
    db.prepare('UPDATE browser_sessions SET active_tab_id=?,revision=revision+1,updated_at=? WHERE id=?').run(tabId, now(), sessionId);
  }
  return {
    getSession, getTab, replay,
    read(sessionId) {
      const session = getSession(sessionId);
      return { session, tabs: db.prepare('SELECT * FROM browser_tabs WHERE session_id=? ORDER BY rowid').all(sessionId).map(tabView),
        snapshots: db.prepare('SELECT * FROM browser_snapshots WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(sessionId).map(snapshotView) };
    },
    create(input) {
      const sessionId = id(input.id), canvasId = id(input.canvasId), tabId = id(input.tab.id);
      if (!['remote-read-only', 'local-interactive'].includes(input.mode)) throw bad('INVALID_BROWSER_MODE');
      const payload = input.identity ?? { sessionId, canvasId, mode: input.mode, backendId: input.backendId, policy: input.policy, tab: input.tab };
      return mutate(input.idempotencyKey, 'create', payload, () => {
        if (sessionView(db.prepare('SELECT * FROM browser_sessions WHERE id=?').get(sessionId))) throw bad('BROWSER_SESSION_EXISTS', 409);
        const timestamp = now();
        db.prepare('INSERT INTO browser_sessions(id,canvas_id,mode,backend_id,policy,active_tab_id,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)')
          .run(sessionId, canvasId, input.mode, id(input.backendId), JSON.stringify(input.policy), tabId, timestamp, timestamp);
        db.prepare('INSERT INTO browser_tabs(id,session_id,url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run(tabId, sessionId, text(input.tab.url, 2048), text(input.tab.title, 240), timestamp, timestamp);
        if (input.tab.snapshot) insertSnapshot(sessionId, tabId, snapshotInput(input.tab.snapshot));
        return result(sessionId, tabId, input.tab.snapshot?.id);
      });
    },
    openTab(input) {
      const sessionId = id(input.sessionId), tabId = id(input.tab.id), payload = input.identity ?? { sessionId, expectedRevision: input.expectedRevision, url: input.tab.url };
      return mutate(input.idempotencyKey, 'open-tab', payload, () => {
        getSession(sessionId);
        db.prepare('INSERT INTO browser_tabs(id,session_id,url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run(tabId, sessionId, text(input.tab.url, 2048), text(input.tab.title, 240), now(), now());
        if (input.tab.snapshot) insertSnapshot(sessionId, tabId, snapshotInput(input.tab.snapshot));
        bump(sessionId, tabId, input.expectedRevision);
        return result(sessionId, tabId, input.tab.snapshot?.id);
      });
    },
    activate(input) {
      const sessionId = id(input.sessionId), tabId = id(input.tabId), payload = input.identity ?? { sessionId, tabId, expectedRevision: input.expectedRevision };
      return mutate(input.idempotencyKey, 'activate-tab', payload, () => {
        getTab(tabId, sessionId); bump(sessionId, tabId, input.expectedRevision);
        return result(sessionId, tabId);
      });
    },
    commitSnapshot(input) {
      const sessionId = id(input.sessionId), tabId = id(input.tabId), snapshot = snapshotInput(input.snapshot);
      const payload = input.identity ?? { sessionId, tabId, expectedRevision: input.expectedRevision, url: snapshot.url };
      return mutate(input.idempotencyKey, 'snapshot', payload, () => {
        getTab(tabId, sessionId); insertSnapshot(sessionId, tabId, snapshot); bump(sessionId, tabId, input.expectedRevision);
        return result(sessionId, tabId, snapshot.id);
      });
    },
    close() { db.close(); },
  };
}
