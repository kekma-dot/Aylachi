import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withOfflineDevelopmentState } from './development-state.mjs';
import { loadRestoredSessionFiles } from './restored-session-files.mjs';
import { snapshotRestoredSessionFiles } from '../agent-host/pi-adapter.mjs';

const FORMAT = 'aylachi-offline-snapshot-v1';
const LIMIT_FILES = 20_000, LIMIT_BYTES = 512 * 1024 * 1024, LIMIT_DIRS = 5_000, LIMIT_DEPTH = 32;
const MARKER = '.aylachi-dev-root';
const DATABASE_FILES = Object.freeze(['core.sqlite', 'handoff.sqlite', 'delegation.sqlite', 'tool-effects.sqlite', 'workspace-graph.sqlite', 'artifacts.sqlite', 'backends.sqlite', 'channels.sqlite', 'memory.sqlite', 'browser.sqlite', 'themes.sqlite']);
const NATIVE_SESSION = /^pi\/sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i;
const inside = (p, base) => p === base || p.startsWith(`${base}${sep}`);
const uid = () => typeof process.getuid === 'function' ? process.getuid() : null;
const fail = code => Object.assign(new Error(code), { code });
const sha = data => createHash('sha256').update(data).digest('hex');

function absolute(p) {
  if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p || p === parse(p).root || p.includes('\0')) throw fail('INVALID_PATH');
  return p;
}
function forbidden(p) {
  const home = resolve(process.env.HOME || homedir());
  return p === home || inside(home, p) || [join(home, '.pi'), join(home, 'BAZA'), join(home, 'Documents', 'BAZA'), '/srv/aylachi/baza', '/srv/aylachi/coding-repos/aylachi/.pi'].some(x => inside(p, x) || inside(x, p));
}
async function dirsNoLinks(p, mustExist = true) {
  let cur = parse(p).root;
  for (const part of p.slice(cur.length).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    let st;
    try { st = await lstat(cur); } catch (e) { if (e.code === 'ENOENT' && !mustExist) return false; throw e; }
    if (!st.isDirectory() || st.isSymbolicLink()) throw fail('UNSAFE_DIRECTORY');
  }
  return true;
}
async function privateDir(p) {
  const st = await lstat(p);
  if (!st.isDirectory() || st.isSymbolicLink() || (uid() !== null && st.uid !== uid()) || (st.mode & 0o077)) throw fail('UNSAFE_DIRECTORY');
  return st;
}
async function readFileChecked(path, expected, allowNativeSessionMode = false) {
  if (!expected.isFile() || expected.isSymbolicLink() || (uid() !== null && expected.uid !== uid()) || (expected.mode & 0o111) || (!allowNativeSessionMode && (expected.mode & 0o077)) || expected.nlink !== 1) throw fail('UNSAFE_FILE');
  if (allowNativeSessionMode && (expected.mode & 0o7002)) throw fail('UNSAFE_FILE');
  if (expected.size > LIMIT_BYTES) throw fail('SNAPSHOT_LIMIT');
  const h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await h.stat();
    if (st.dev !== expected.dev || st.ino !== expected.ino || st.size !== expected.size || st.nlink !== 1 || (uid() !== null && st.uid !== uid())) throw fail('SOURCE_CHANGED');
    const b = await h.readFile();
    if (b.length !== st.size) throw fail('SOURCE_CHANGED');
    return b;
  } finally { await h.close(); }
}
function dbCheck(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').all().some(r => Object.values(r)[0] !== 'ok')) throw fail('SQLITE_INTEGRITY');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw fail('SQLITE_FOREIGN_KEY');
  } finally { db.close(); }
}

export async function snapshotDevelopmentState({ stateRoot, snapshotRoot } = {}) {
  const source = absolute(stateRoot), destination = absolute(snapshotRoot);
  if (source === destination || inside(source, destination) || inside(destination, source) || forbidden(destination)) throw fail('UNSAFE_DESTINATION');
  await dirsNoLinks(dirname(destination));
  try { await lstat(destination); throw fail('DESTINATION_EXISTS'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return withOfflineDevelopmentState(source, async root => {
    try { await mkdir(destination, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw fail('DESTINATION_EXISTS'); throw e; }
    await privateDir(destination);
    const rootStat = await privateDir(root);
    const names = await readdir(root);
    for (const db of DATABASE_FILES) {
      for (const suffix of ['-wal', '-shm', '-journal']) if (names.includes(db + suffix)) throw fail('SQLITE_SIDECAR_PRESENT');
    }
    const excluded = ['.bearer', '.server-address', '.server.lock', '.live-used', 'workspace', 'live-budget.json', 'auth.json', 'credentials', 'secrets', 'tokens', 'cookies'];
    const allowed = new Set([MARKER, ...DATABASE_FILES, '.restored-session-files.json', 'wiki', 'pi', ...excluded, ...DATABASE_FILES.flatMap(db => ['-wal', '-shm', '-journal'].map(s => db + s))]);
    if (names.some(n => !allowed.has(n))) throw fail('UNSUPPORTED_SOURCE_ENTRY');
    const files = [], dbs = [], manifest = { format: FORMAT, source: root, marker: MARKER, schema: { core: 'persistence/store.mjs', handoff: 'handoff/store.mjs', delegation: 'delegation/store.mjs', effects: 'delegation/effects.mjs', graph: 'workspace/graph-store.mjs', artifacts: 'artifact-engine/store.mjs', backends: 'backends/store.mjs', channels: 'channels/store.mjs', memory: 'memory/store.mjs', browser: 'browser/store.mjs', themes: 'themes/store.mjs', wiki: 'wiki/wiki.mjs' }, excluded, files };
    let total = 0, directoryCount = 0;
    async function addFile(rel, path, required = false) {
      let st;
      try { st = await lstat(path); } catch (e) { if (!required && e.code === 'ENOENT') return; throw e; }
      const nativeSession = NATIVE_SESSION.test(rel);
      if (!st.isFile() || st.isSymbolicLink() || (uid() !== null && st.uid !== uid()) || (!nativeSession && (st.mode & 0o077)) || st.nlink !== 1) throw fail('UNSAFE_FILE');
      if (rel.startsWith('wiki/')) {
        const noteId = rel.split('/')[1];
        if (!/^[a-f0-9-]{36}$/i.test(noteId)) throw fail('UNSUPPORTED_TREE_ENTRY');
      }
      if (st.size > LIMIT_BYTES || files.length >= LIMIT_FILES || total + st.size > LIMIT_BYTES) throw fail('SNAPSHOT_LIMIT');
      const bytes = await readFileChecked(path, st, nativeSession);
      total += bytes.length;
      files.push({ path: rel, size: bytes.length, sha256: sha(bytes), sourceMode: st.mode & 0o777, destinationMode: 0o600 });
      if (rel.endsWith('.sqlite')) dbs.push(rel);
      return bytes;
    }
    const marker = await addFile(MARKER, join(root, MARKER), true);
    if (marker.toString() !== 'aylachi-development-state-v1\n') throw fail('INVALID_MARKER');
    for (const db of DATABASE_FILES) await addFile(db, join(root, db), db === 'core.sqlite');
    await addFile('.restored-session-files.json', join(root, '.restored-session-files.json'));
    async function walk(rel, depth = 1) {
      if (depth > LIMIT_DEPTH || ++directoryCount > LIMIT_DIRS) throw fail('SNAPSHOT_LIMIT');
      const dir = join(root, rel), ds = await privateDir(dir);
      if (ds.mode & 0o077) throw fail('UNSAFE_DIRECTORY');
      const entries = await readdir(dir);
      for (const name of entries) {
        const child = `${rel}/${name}`, path = join(root, child), st = await lstat(path);
        const nativeSessionFile = NATIVE_SESSION.test(child);
        if (st.isSymbolicLink() || (uid() !== null && st.uid !== uid()) || (!nativeSessionFile && (st.mode & 0o077))) throw fail('UNSAFE_TREE_ENTRY');
        if (/(?:auth|credential|secret|token|cookie)/i.test(name)) throw fail('EXCLUDED_SECRET_PATH');
        if (st.isDirectory()) {
          if (child === 'pi/agent' || child === 'pi/sessions' || /^pi\/sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(child)) await privateDir(path);
          await walk(child, depth + 1);
        }
        else if (st.isFile() && NATIVE_SESSION.test(child)) {
          await privateDir(join(root, 'pi'));
          await privateDir(join(root, 'pi', 'sessions'));
          await privateDir(dirname(path));
          await addFile(child, path);
        }
        else if (st.isFile() && (/^wiki\/[a-f0-9-]{36}\/CURRENT$/i.test(child) || /^wiki\/[a-f0-9-]{36}\/revisions\/[a-f0-9-]{36}\.md$/i.test(child))) await addFile(child, path);
        else throw fail('UNSUPPORTED_TREE_ENTRY');
        if (files.length > LIMIT_FILES) throw fail('SNAPSHOT_LIMIT');
      }
    }
    for (const tree of ['wiki', 'pi']) if (names.includes(tree)) await walk(tree);
    if (files.length > LIMIT_FILES) throw fail('SNAPSHOT_LIMIT');
    for (const rel of files.map(f => f.path)) {
      const sourcePath = join(root, rel), destPath = join(destination, rel);
      const destDir = dirname(destPath);
      const relativeDir = destDir.slice(destination.length).split(sep).filter(Boolean);
      let current = destination;
      for (const part of relativeDir) {
        current = join(current, part);
        try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        await privateDir(current);
      }
      const nativeSession = NATIVE_SESSION.test(rel);
      const now = await lstat(sourcePath), bytes = await readFileChecked(sourcePath, now, nativeSession);
      if (sha(bytes) !== files.find(f => f.path === rel).sha256) throw fail('SOURCE_DRIFT');
      const h = await open(destPath, 'wx', 0o600);
      try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
      const copied = await lstat(destPath);
      if (!copied.isFile() || copied.nlink !== 1 || (uid() !== null && copied.uid !== uid()) || (copied.mode & 0o077)) throw fail('UNSAFE_SNAPSHOT_FILE');
    }
    for (const rel of dbs) dbCheck(join(destination, rel));
    for (const f of files) {
      const nativeSession = NATIVE_SESSION.test(f.path);
      const st = await lstat(join(root, f.path)), b = await readFileChecked(join(root, f.path), st, nativeSession);
      if (sha(b) !== f.sha256) throw fail('SOURCE_DRIFT');
    }
    manifest.sourceIdentity = { dev: rootStat.dev, ino: rootStat.ino };
    manifest.sourceFile = new URL(import.meta.url).pathname;
    const mf = join(destination, 'manifest.json');
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const h = await open(mf, 'wx', 0o600);
    try { await h.writeFile(manifestBytes); await h.sync(); } finally { await h.close(); }
    return { snapshotRoot: destination, files: files.length, bytes: total, format: FORMAT, manifestSha256: sha(manifestBytes) };
  });
}

const RESTORE_ROOT_FILES = new Set([MARKER, ...DATABASE_FILES, '.restored-session-files.json']);
const RESTORE_EXCLUDED = new Set(['.bearer', '.server-address', '.server.lock', '.live-used', 'workspace', 'live-budget.json', 'auth.json', 'credentials', 'secrets', 'tokens', 'cookies']);
const HASH64 = /^[a-f0-9]{64}$/;
const MANIFEST_LIMIT_BYTES = 16 * 1024 * 1024;
const RESTORE_DB_COLUMNS = {
  'core.sqlite': {
    cards: 'id,canvas_id,session_id,title,x,y,revision',
    commands: 'id,card_id,input,state,result',
    events: 'offset,card_id,kind,payload',
  },
  'handoff.sqlite': {
    handoff_records: 'id,owner,request_id,payload_hash,source_json,target_card_id,snapshot_json,state,created_at,accepted_at',
    handoff_requests: 'actor,request_id,action,request_hash,handoff_id',
  },
  'delegation.sqlite': {
    delegation_records: 'id,actor,request_id,request_hash,parent_command_id,parent_card_id,canvas_id,text,child_card_id,child_session_id,lease_id,child_command_id,cancel_request_id,state,result_json,created_at,updated_at,last_expected_state',
  },
  'tool-effects.sqlite': {
    tool_effects: 'id,actor,request_id,parent_command_id,parent_card_id,canvas_id,tool_name,text,payload_hash,attempt,owner_id,state,reason_code,receipt_json,created_at,updated_at',
  },
  'backends.sqlite': {
    backend_conversations: 'card_id,backend_id,backend_revision,session_id,created_at',
  },
  'channels.sqlite': {
    channel_routes: 'id,channel,account_id,chat_id,thread_id,conversation_id,state,revision,created_at,updated_at',
    channel_inbox: 'id,route_id,external_message_id,acting_principal,text,command_id,state,handoff_json,created_at',
    channel_outbox: 'id,inbox_id,route_id,text,state,receipt_json,created_at,updated_at',
  },
  'memory.sqlite': {
    memory_targets: 'target_id,revision',
    memory_proposals: 'id,owner,request_id,target_id,base_revision,content,worktree,branch,state,revision,reviewer,review_note,promotion_ticket,receipt_json,created_at,updated_at',
  },
  'browser.sqlite': {
    browser_sessions: 'id,canvas_id,mode,backend_id,policy,active_tab_id,revision,created_at,updated_at',
    browser_tabs: 'id,session_id,url,title,created_at,updated_at',
    browser_snapshots: 'id,session_id,tab_id,url,title,text,links,created_at',
    browser_requests: 'key,operation,request_hash,result',
  },
  'themes.sqlite': {
    themes: 'id,name,base,origin,state,current_version,created_at,updated_at',
    theme_versions: 'theme_id,version,tokens,created_at',
    workspace_themes: 'canvas_id,theme_id,revision,updated_at',
    theme_requests: 'key,operation,request_hash,result',
  },
  'artifacts.sqlite': {
    artifacts: 'id,current_version,created_at,updated_at',
    versions: 'artifact_id,version,title,format,content,content_hash,sources,origin,created_at',
    requests: 'key,operation,request_hash,artifact_id,version',
  },
  'workspace-graph.sqlite': {
    nodes: 'id,canvas_id,kind,ref_id,title,x,y,width,height,revision,settings',
    edges: 'id,canvas_id,source_node_id,target_node_id,kind,source_port_id,target_port_id,data_type',
    runs: 'id,canvas_id,root_node_id,scope,status,created_at,completed_at',
    run_nodes: 'run_id,node_id,attempt,status,input_hash',
    artifacts: 'id,run_id,node_id,attempt,kind,ref_id,revision,content,state,metadata,created_at',
  },
};
function restoreDbCheck(path, name) {
  dbCheck(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const [table, columns] of Object.entries(RESTORE_DB_COLUMNS[name])) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name).join(',');
      const additiveCards = name === 'core.sqlite' && table === 'cards' &&
        actual === 'id,canvas_id,session_id,title,x,y,revision,width,height,model_provider,model_id,reasoning';
      if (actual !== columns && !additiveCards) throw fail('UNSUPPORTED_DATABASE_SCHEMA');
    }
  } finally { db.close(); }
}

function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).some(k => !['path', 'size', 'sha256', 'sourceMode', 'destinationMode'].includes(k)) ||
      typeof record.path !== 'string' || !Number.isSafeInteger(record.size) || record.size < 0 ||
      !HASH64.test(record.sha256) || !Number.isInteger(record.sourceMode) || record.sourceMode < 0 || record.sourceMode > 0o777 || !Number.isInteger(record.destinationMode) || record.destinationMode !== 0o600) throw fail('INVALID_MANIFEST');
  const p = record.path;
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || p.split('/').some(part => !part || part === '.' || part === '..') || RESTORE_EXCLUDED.has(p) || /(?:auth|credential|secret|token|cookie)/i.test(p)) throw fail('INVALID_MANIFEST');
  const native = NATIVE_SESSION.test(p);
  const known = RESTORE_ROOT_FILES.has(p) || /^wiki\/[a-f0-9-]{36}\/(?:CURRENT|revisions\/[a-f0-9-]{36}\.md)$/i.test(p) || native;
  if (!known || (native ? (record.sourceMode & 0o7002) !== 0 : (record.sourceMode & 0o777) !== 0o600)) throw fail('INVALID_MANIFEST');
  return native;
}

export async function restoreDevelopmentState({ snapshotRoot, restoreRoot, expectedManifestSha256, sdk } = {}) {
  if (typeof expectedManifestSha256 !== 'string' || !HASH64.test(expectedManifestSha256)) throw fail('UNTRUSTED_MANIFEST_HASH');
  const source = absolute(snapshotRoot), destination = absolute(restoreRoot);
  if (source === destination || inside(source, destination) || inside(destination, source) || forbidden(source) || forbidden(destination)) throw fail('UNSAFE_DESTINATION');
  await dirsNoLinks(dirname(source)); await dirsNoLinks(dirname(destination));
  await privateDir(source);
  if (await realpath(source) !== source) throw fail('UNSAFE_DIRECTORY');
  try { await lstat(destination); throw fail('DESTINATION_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const mfStat = await lstat(join(source, 'manifest.json'));
  if (mfStat.size > MANIFEST_LIMIT_BYTES) throw fail('SNAPSHOT_LIMIT');
  const manifestBytes = await readFileChecked(join(source, 'manifest.json'), mfStat);
  if (sha(manifestBytes) !== expectedManifestSha256) throw fail('MANIFEST_HASH_MISMATCH');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw fail('INVALID_MANIFEST'); }
  if (!manifest || manifest.format !== FORMAT || !Array.isArray(manifest.files) || manifest.files.length > LIMIT_FILES ||
      manifest.marker !== MARKER || !manifest.schema || typeof manifest.schema !== 'object' || Array.isArray(manifest.schema) ||
      !['core', 'delegation', 'handoff', 'wiki'].every(key => Object.hasOwn(manifest.schema, key)) ||
      Object.keys(manifest.schema).some(key => !['core', 'delegation', 'effects', 'graph', 'artifacts', 'backends', 'channels', 'memory', 'browser', 'themes', 'handoff', 'wiki'].includes(key)) ||
      manifest.schema.core !== 'persistence/store.mjs' || manifest.schema.handoff !== 'handoff/store.mjs' || manifest.schema.delegation !== 'delegation/store.mjs' || manifest.schema.wiki !== 'wiki/wiki.mjs' ||
      (Object.hasOwn(manifest.schema, 'graph') && manifest.schema.graph !== 'workspace/graph-store.mjs') ||
      (Object.hasOwn(manifest.schema, 'effects') && manifest.schema.effects !== 'delegation/effects.mjs') ||
      (Object.hasOwn(manifest.schema, 'artifacts') && manifest.schema.artifacts !== 'artifact-engine/store.mjs') ||
      (Object.hasOwn(manifest.schema, 'backends') && manifest.schema.backends !== 'backends/store.mjs') ||
      (Object.hasOwn(manifest.schema, 'channels') && manifest.schema.channels !== 'channels/store.mjs') ||
      (Object.hasOwn(manifest.schema, 'memory') && manifest.schema.memory !== 'memory/store.mjs') ||
      (Object.hasOwn(manifest.schema, 'browser') && manifest.schema.browser !== 'browser/store.mjs') ||
      (Object.hasOwn(manifest.schema, 'themes') && manifest.schema.themes !== 'themes/store.mjs')) throw fail('INVALID_MANIFEST');
  let total = 0; const records = new Map(), nativeById = new Map();
  for (const rec of manifest.files) {
    const native = validRecord(rec);
    if (records.has(rec.path)) throw fail('INVALID_MANIFEST');
    total += rec.size;
    if (total > LIMIT_BYTES) throw fail('SNAPSHOT_LIMIT');
    records.set(rec.path, rec);
    if (native) { const id = rec.path.split('/')[2]; nativeById.set(id, [...(nativeById.get(id) || []), rec.path]); }
  }
  if (!records.has(MARKER) || !records.has('core.sqlite')) throw fail('INVALID_MANIFEST');
  const snapshotFiles = new Set(), allowedDirs = new Set(); let dirs = 0;
  for (const path of records.keys()) {
    let parent = dirname(path);
    while (parent !== '.') { allowedDirs.add(parent); parent = dirname(parent); }
  }
  async function inspect(rel = '') {
    const dir = rel ? join(source, rel) : source;
    const entries = await readdir(dir);
    for (const name of entries) {
      const child = rel ? `${rel}/${name}` : name;
      if (!rel && child === 'manifest.json') continue;
      if (++dirs > LIMIT_DIRS + LIMIT_FILES) throw fail('SNAPSHOT_LIMIT');
      const st = await lstat(join(source, child));
      if (st.isSymbolicLink() || (uid() !== null && st.uid !== uid())) throw fail('UNSAFE_TREE_ENTRY');
      if (st.isDirectory()) { if ((st.mode & 0o777) !== 0o700 || !allowedDirs.has(child) || child.split('/').length > LIMIT_DEPTH) throw fail('UNSAFE_DIRECTORY'); await inspect(child); }
      else if (st.isFile()) { if (st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || !records.has(child) || snapshotFiles.has(child)) throw fail('UNLISTED_FILE'); snapshotFiles.add(child); }
      else throw fail('UNSAFE_TREE_ENTRY');
    }
  }
  await inspect();
  if (snapshotFiles.size !== records.size) throw fail('UNLISTED_FILE');
  let bindings;
  const bindingRecord = records.get('.restored-session-files.json');
  const sourceBytes = new Map();
  async function readRecord(path, rec) {
    const st = await lstat(join(source, path));
    const bytes = await readFileChecked(join(source, path), st, NATIVE_SESSION.test(path));
    if (bytes.length !== rec.size || sha(bytes) !== rec.sha256) throw fail('FILE_HASH_MISMATCH');
    sourceBytes.set(path, bytes);
    return bytes;
  }
  if (bindingRecord) {
    const bytes = await readRecord('.restored-session-files.json', bindingRecord);
    try { bindings = JSON.parse(bytes.toString('utf8')); } catch { throw fail('INVALID_SESSION_BINDING'); }
    if (!bindings || Object.keys(bindings).length !== 2 || bindings.format !== 1 || !bindings.sessions || typeof bindings.sessions !== 'object' || Array.isArray(bindings.sessions)) throw fail('INVALID_SESSION_BINDING');
    for (const [id, basename] of Object.entries(bindings.sessions)) if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || typeof basename !== 'string' || basename.includes('/') || !nativeById.get(id)?.some(p => p.endsWith(`/${basename}`))) throw fail('INVALID_SESSION_BINDING');
  } else {
    const sessions = {};
    for (const [id, paths] of nativeById) { if (paths.length !== 1) throw fail('AMBIGUOUS_SESSION'); sessions[id] = paths[0].split('/').at(-1); }
    if (Object.keys(sessions).length) bindings = { format: 1, sessions };
  }
  if (bindings && (Object.keys(bindings.sessions).length !== nativeById.size || [...nativeById.keys()].some(id => !Object.hasOwn(bindings.sessions, id)))) throw fail('INVALID_SESSION_BINDING');
  if (nativeById.size && (!sdk || typeof sdk.SessionManager?.open !== 'function')) throw fail('SDK_REQUIRED');
  if (nativeById.size) {
    try { bindings = { format: 1, sessions: snapshotRestoredSessionFiles(bindings.sessions) }; }
    catch { throw fail('INVALID_SESSION_BINDING'); }
  }
  // Validate the full source payload before creating any destination.
  const verified = new Map();
  for (const [p, rec] of records) verified.set(p, sourceBytes.get(p) ?? await readRecord(p, rec));
  const marker = verified.get(MARKER);
  if (!marker || marker.toString() !== 'aylachi-development-state-v1\n') throw fail('INVALID_MARKER');
  try { await mkdir(destination, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw fail('DESTINATION_EXISTS'); throw e; }
  await privateDir(destination);
  if (((await lstat(destination)).mode & 0o777) !== 0o700) throw fail('UNSAFE_DIRECTORY');
  try {
    const live = await open(join(destination, '.live-used'), 'wx', 0o600); await live.sync(); await live.close();
    const liveStat = await lstat(join(destination, '.live-used'));
    if (!liveStat.isFile() || liveStat.nlink !== 1 || (liveStat.mode & 0o777) !== 0o600) throw fail('RESTORE_VERIFY_FAILED');
    for (const [p, bytes] of verified) {
      if (p === MARKER || p === '.restored-session-files.json') continue;
      let dir = destination;
      for (const part of dirname(p).split('/').filter(x => x !== '.')) { dir = join(dir, part); try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } await privateDir(dir); if (((await lstat(dir)).mode & 0o777) !== 0o700) throw fail('UNSAFE_DIRECTORY'); }
      const target = join(destination, p), h = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
      const copiedStat = await lstat(target), copied = await readFileChecked(target, copiedStat);
      if ((copiedStat.mode & 0o777) !== 0o600 || sha(copied) !== sha(bytes)) throw fail('RESTORE_VERIFY_FAILED');
      if (p.endsWith('.sqlite')) restoreDbCheck(target, p);
    }
    if (bindings) await writePrivate(join(destination, '.restored-session-files.json'), Buffer.from(JSON.stringify(bindings)), 0o600);
    if (nativeById.size) {
      for (const [id, basename] of Object.entries(bindings.sessions)) {
        const file = join(destination, 'pi', 'sessions', id, basename), manager = sdk.SessionManager.open(file, join(destination, 'pi', 'sessions', id), join(destination, 'workspace'));
        const header = manager?.getHeader?.(), sessionUuid = basename.slice(-42, -6);
        if (!manager || header?.type !== 'session' || header.id !== sessionUuid || manager.getSessionId() !== sessionUuid || manager.getSessionFile() !== file || manager.getCwd() !== join(destination, 'workspace') || !Number.isInteger(manager.getEntryCount()) || manager.getEntryCount() < 1) throw fail('SESSION_METADATA_INVALID');
      }
      await loadRestoredSessionFiles(destination);
    }
    for (const p of records.keys()) { if (p === MARKER || p === '.restored-session-files.json') continue; const b = await readFileChecked(join(source, p), await lstat(join(source, p)), NATIVE_SESSION.test(p)); if (sha(b) !== records.get(p).sha256) throw fail('SOURCE_CHANGED'); }
    const pendingMarker = join(destination, '.restore-pending');
    await writePrivate(pendingMarker, marker, 0o600);
    try { await lstat(join(destination, MARKER)); throw fail('RESTORE_ROOT_CHANGED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The new private root has no cooperating writer. Publish readiness in one rename;
    // failure retains the pending artifact, which the server refuses. Not a power-loss proof.
    await rename(pendingMarker, join(destination, MARKER));
    return { restoreRoot: destination, files: records.size, bytes: total, format: FORMAT };
  } catch (error) {
    // Preserve failed output for inspection; never delete a marker or original data.
    throw error;
  }
}

async function writePrivate(path, bytes, mode) {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
}
