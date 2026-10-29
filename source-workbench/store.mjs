import fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { diffMarkdown } from '../wiki/markdown-diff.mjs';

const MARKER = Buffer.from('aylachi-source-workbench-v1\n');
const MAX_FILE = 32 * 1024, MAX_FILES = 16, MAX_BACKUPS = 64;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const EXT = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.css']);
function secretBasename(name) {
  const lower = name.toLowerCase();
  return lower.startsWith('.env') || /(?:^|[._-])(?:auth|credentials?|secrets?|token)(?:[._-]|$)/i.test(name);
}
const OWNER = process.getuid?.();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

function record(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail(`INVALID_${name}`);
  const own = Reflect.ownKeys(value);
  if (own.some(k => typeof k !== 'string') || own.length !== keys.length || keys.some(k => !own.includes(k))) throw fail(`INVALID_${name}`);
  const out = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) throw fail(`INVALID_${name}`);
    out[key] = d.value;
  }
  return out;
}
function array(value, name, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) throw fail(`INVALID_${name}`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length') || keys.some(k => typeof k === 'symbol')) throw fail(`INVALID_${name}`);
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) throw fail(`INVALID_${name}`);
    out.push(d.value);
  }
  return out;
}
function canonicalRel(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(JSON.stringify(value), 'utf8') > 512 || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) ||
      value.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.')) || path.posix.normalize(value) !== value) throw fail('INVALID_PATH');
  const base = path.posix.basename(value);
  if (secretBasename(base) || !EXT.has(path.posix.extname(base))) throw fail('INVALID_PATH');
  return value;
}
function canonicalAbs(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) throw fail('INVALID_ROOT');
  return value;
}
function overlaps(a, b) {
  const root = path.parse(b).root;
  return a === b || b === root || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}
function mode(st, expected, links = 1) {
  if (OWNER !== undefined && st.uid !== OWNER) throw fail('UNSAFE_OWNER');
  if ((st.mode & 0o022) !== 0 || (expected !== null && (st.mode & 0o777) !== expected) || (links !== null && st.nlink !== links)) throw fail('UNSAFE_MODE_OR_LINK');
}
function privateMode(st, expected = 0o700, links = 1) {
  if (OWNER !== undefined && st.uid !== OWNER) throw fail('UNSAFE_OWNER');
  if ((st.mode & 0o777) !== expected || (links !== null && st.nlink !== links)) throw fail('UNSAFE_MODE_OR_LINK');
}
function decode(bytes, limit = MAX_FILE) {
  if (bytes.length > limit || bytes.includes(0)) throw fail('INVALID_SOURCE');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail('INVALID_UTF8'); }
}
async function statNoLink(p) { const s = await fs.lstat(p); if (s.isSymbolicLink()) throw fail('SYMLINK'); return s; }
async function directory(p, privateDir = true) {
  const s = await statNoLink(p); if (!s.isDirectory()) throw fail('UNSAFE_DIRECTORY');
  if (privateDir) privateMode(s, 0o700, null); else mode(s, null, null);
  if (await fs.realpath(p) !== p) throw fail('NONCANONICAL_PATH'); return s;
}
async function readFile(p, max = MAX_FILE, expectedMode = null) {
  const before = await statNoLink(p); if (!before.isFile()) throw fail('UNSAFE_FILE');
  if (expectedMode === null) mode(before, null); else privateMode(before, expectedMode);
  const fd = await fs.open(p, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const opened = await fd.stat();
    if (expectedMode === null) mode(opened, null); else privateMode(opened, expectedMode);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > max) throw fail('SOURCE_CHANGED');
    const chunks = []; let total = 0;
    while (total <= max) {
      const chunk = Buffer.alloc(Math.min(4096, max + 1 - total));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead;
    }
    if (total > max) throw fail('SOURCE_CHANGED');
    const after = await statNoLink(p), openedAfter = await fd.stat();
    if (total !== opened.size || openedAfter.dev !== opened.dev || openedAfter.ino !== opened.ino || openedAfter.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) throw fail('SOURCE_CHANGED');
    return Buffer.concat(chunks, total);
  } finally { await fd.close(); }
}
async function mkdirOwned(p) { await fs.mkdir(p, { mode: 0o700 }); await directory(p); }
// Hostile same-UID concurrent replacement is not certified; path and inode checks only narrow that race.

export function snapshotSourceWorkbenchConfig(config) {
  const c = record(config, ['labRoot', 'files', 'forbiddenRoots', 'authorize'], 'CONFIG');
  const labRoot = canonicalAbs(c.labRoot);
  const fileInputs = array(c.files, 'FILES', MAX_FILES);
  const forbiddenInputs = array(c.forbiddenRoots, 'FORBIDDEN_ROOTS', 128);
  const files = fileInputs.map(value => {
    const row = record(value, ['id', 'path'], 'FILE_BINDING');
    if (typeof row.id !== 'string' || !SLUG.test(row.id)) throw fail('INVALID_FILE_ID');
    return Object.freeze({ id: row.id, path: canonicalRel(row.path) });
  });
  if (!files.length || new Set(files.map(x => x.id)).size !== files.length || new Set(files.map(x => x.path)).size !== files.length) throw fail('INVALID_FILE_BINDINGS');
  const forbidden = forbiddenInputs.map(canonicalAbs);
  // These are trusted canonical literals: lexical overlap avoids touching protected roots. Parent must provide the full set; mount aliases are not resolved.
  if (labRoot === path.parse(labRoot).root || forbidden.some(root => overlaps(labRoot, root))) throw fail('FORBIDDEN_ROOT_OVERLAP');
  if (typeof c.authorize !== 'function') throw fail('AUTHORIZE_REQUIRED');
  return Object.freeze({ labRoot, files: Object.freeze(files), forbiddenRoots: Object.freeze(forbidden), authorize: c.authorize });
}

export async function openSourceWorkbench(config) {
  const c = snapshotSourceWorkbenchConfig(config);
  const { labRoot, files } = c;
  if (process.platform !== 'linux' || typeof C.O_NOFOLLOW !== 'number') throw fail('LINUX_DURABILITY_REQUIRED');
  const checkout = path.join(labRoot, 'checkout'), state = path.join(labRoot, '.workbench');
  const marker = path.join(labRoot, '.aylachi-source-lab'), backups = path.join(state, 'backups');
  let lockHandle, closed = false, closing = false, closePromise = null, chain = Promise.resolve();
  async function validateSources() {
    await directory(labRoot); await directory(checkout);
    if (!(await readFile(marker, MARKER.length, 0o600)).equals(MARKER)) throw fail('INVALID_MARKER');
    for (const file of files) {
      let parent = checkout;
      const parts = file.path.split('/');
      for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); await directory(parent, false); }
      const target = path.join(checkout, ...parts), st = await statNoLink(target);
      if (!st.isFile()) throw fail('UNSAFE_FILE'); mode(st, null);
      if (await fs.realpath(target) !== target) throw fail('NONCANONICAL_PATH');
      decode(await readFile(target));
    }
  }
  async function validateState() {
    await directory(state); await directory(backups);
    const published = await loadManifest();
    if (!published || JSON.stringify(published) !== JSON.stringify(manifest)) throw fail('INVALID_MANIFEST');
  }
  await validateSources();
  const stateStat = await statNoLink(state).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (stateStat) {
    if (!stateStat.isDirectory()) throw fail('UNSAFE_DIRECTORY'); privateMode(stateStat, 0o700, null);
    await directory(backups);
    const manifestExists = await statNoLink(path.join(state, 'manifest.json')).then(s => s.isFile(), e => e.code === 'ENOENT' ? false : Promise.reject(e));
    if (!manifestExists) throw fail('PARTIAL_STATE');
  } else { await mkdirOwned(state); await mkdirOwned(backups); }
  const lockPath = path.join(state, 'lock');
  try { lockHandle = await fs.open(lockPath, C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW, 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw fail('WORKBENCH_LOCKED'); throw e; }
  const lockToken = randomBytes(24).toString('hex'), lockStat = await lockHandle.stat();
  try { privateMode(lockStat, 0o600); await lockHandle.writeFile(lockToken); await lockHandle.sync(); }
  catch (e) {
    await lockHandle.close();
    const existing = await statNoLink(lockPath).catch(() => null);
    if (existing && existing.dev === lockStat.dev && existing.ino === lockStat.ino) await fs.unlink(lockPath).catch(() => {});
    throw e;
  }
  const manifestPath = path.join(state, 'manifest.json');
  const enqueue = fn => {
    if (closing) return Promise.reject(fail('CLOSED'));
    const job = chain.then(async () => { if (closed) throw fail('CLOSED'); return fn(); });
    chain = job.catch(() => {}); return job;
  };
  async function loadManifest() {
    let bytes;
    try { bytes = await readFile(manifestPath, 16 * 1024, 0o600); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try {
      const parsed = JSON.parse(decode(bytes, 16 * 1024));
      if (!parsed || Object.keys(parsed).sort().join(',') !== 'files,version' || parsed.version !== 1 || !Array.isArray(parsed.files) || parsed.files.length !== files.length ||
          parsed.files.some((f, i) => !f || Object.keys(f).sort().join(',') !== 'baselineSha256,id,path' || f.id !== files[i].id || f.path !== files[i].path || !HASH.test(f.baselineSha256))) throw fail('INVALID_MANIFEST');
      return parsed;
    } catch { throw fail('INVALID_MANIFEST'); }
  }
  async function publishManifest(value) {
    const temp = `${manifestPath}.${randomBytes(12).toString('hex')}.tmp`;
    const fd = await fs.open(temp, C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
    await fs.rename(temp, manifestPath);
    const dir = await fs.open(state, C.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
  }
  async function storeBackup(fileId, bytes, digest) {
    const dir = path.join(backups, fileId);
    await mkdirOwned(dir).catch(async e => { if (e.code !== 'EEXIST') throw e; await directory(dir); });
    const target = path.join(dir, `${digest}.utf8`);
    const existing = await statNoLink(target).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (existing) { const current = await readFile(target, MAX_FILE, 0o600); if (hash(current) !== digest || !current.equals(bytes)) throw fail('BACKUP_VERIFY_FAILED'); return; }
    const fd = await fs.open(target, C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
    const verified = await readFile(target, MAX_FILE, 0o600);
    if (!verified.equals(bytes) || hash(verified) !== digest) throw fail('BACKUP_VERIFY_FAILED');
    const dfd = await fs.open(dir, C.O_RDONLY); try { await dfd.sync(); } finally { await dfd.close(); }
  }
  async function readBackup(fileId, digest) {
    if (!SLUG.test(fileId) || !HASH.test(digest)) throw fail('INVALID_BACKUP_REFERENCE');
    await directory(backups); await directory(path.join(backups, fileId));
    const bytes = await readFile(path.join(backups, fileId, `${digest}.utf8`), MAX_FILE, 0o600);
    if (hash(bytes) !== digest) throw fail('BACKUP_VERIFY_FAILED'); return bytes;
  }
  async function current(file) {
    const bytes = await readFile(path.join(checkout, ...file.path.split('/')));
    return { bytes, content: decode(bytes), sha256: hash(bytes) };
  }
  let manifest;
  try {
    manifest = await loadManifest();
    if (!manifest) {
      if (stateStat) throw fail('PARTIAL_STATE');
      const rows = [];
      for (const file of files) {
        const source = await current(file); await storeBackup(file.id, source.bytes, source.sha256);
        rows.push({ id: file.id, path: file.path, baselineSha256: source.sha256 });
      }
      manifest = { version: 1, files: rows };
      await publishManifest(manifest);
    }
    for (const row of manifest.files) await readBackup(row.id, row.baselineSha256);
  } catch (cause) {
    const own = await lockHandle.stat().catch(() => null), st = await statNoLink(lockPath).catch(() => null);
    const matches = own && st && own.dev === st.dev && own.ino === st.ino;
    const token = matches ? await readFile(lockPath, 128, 0o600).catch(() => null) : null;
    if (matches && token?.toString() === lockToken) await fs.unlink(lockPath).catch(() => {});
    await lockHandle.close().catch(() => {});
    throw cause;
  }
  const baselines = new Map(manifest.files.map(row => [row.id, row]));
  async function backupCount(fileId) {
    const dir = path.join(backups, fileId); await directory(backups); await directory(dir);
    const names = await fs.readdir(dir);
    if (names.some(name => !name.endsWith('.utf8') || !HASH.test(name.slice(0, -5)))) throw fail('INVALID_BACKUP_STORE');
    return names.length;
  }
  async function authorize(actor, operation) { if (await c.authorize({ actor, operation }) !== true) throw fail('POLICY_DENIED'); }
  function find(id) { if (typeof id !== 'string' || !SLUG.test(id)) throw fail('INVALID_FILE_ID'); const file = files.find(f => f.id === id); if (!file) throw fail('UNKNOWN_FILE'); return file; }
  function output(file, source) { return { id: file.id, path: file.path, content: source.content, sha256: source.sha256, baselineSha256: baselines.get(file.id).baselineSha256 }; }
  const api = {
    list({ actor } = {}) { return enqueue(async () => { await authorize(actor, 'list'); await validateSources(); await validateState(); return { files: await Promise.all(files.map(async f => ({ id: f.id, path: f.path, sha256: (await current(f)).sha256, baselineSha256: baselines.get(f.id).baselineSha256 }))) }; }); },
    read({ actor, id } = {}) { return enqueue(async () => { await authorize(actor, 'read'); await validateSources(); await validateState(); const file = find(id); return output(file, await current(file)); }); },
    save({ actor, id, content, expectedSha256 } = {}) { return enqueue(async () => {
      await authorize(actor, 'save'); await validateSources(); await validateState(); const file = find(id);
      if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > MAX_FILE || !HASH.test(expectedSha256 ?? '')) throw fail('INVALID_SAVE');
      const bytes = Buffer.from(content, 'utf8'); if (decode(bytes) !== content) throw fail('INVALID_UTF8');
      const old = await current(file); if (old.sha256 !== expectedSha256) throw fail('CONFLICT');
      if (content === old.content) return { ...output(file, old), unchanged: true };
      const baseline = baselines.get(id); await readBackup(id, baseline.baselineSha256);
      const oldBackup = await statNoLink(path.join(backups, id, `${old.sha256}.utf8`)).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
      if (!oldBackup && await backupCount(id) >= MAX_BACKUPS) throw fail('BACKUP_LIMIT');
      const backupSha256 = old.sha256; await storeBackup(id, old.bytes, backupSha256);
      const target = path.join(checkout, ...file.path.split('/')), parent = path.dirname(target);
      const temp = path.join(parent, `.workbench-${randomBytes(16).toString('hex')}.tmp`), before = await statNoLink(target);
      const fd = await fs.open(temp, C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW, 0o600);
      // Preserve partial temp evidence on failure as required for recovery diagnostics.
      try { if ((await fd.stat()).dev !== before.dev) throw fail('CROSS_DEVICE'); await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
      const recheck = await current(file), now = await statNoLink(target);
      if (recheck.sha256 !== expectedSha256 || now.dev !== before.dev || now.ino !== before.ino) throw fail('CONFLICT');
      await fs.rename(temp, target);
      const dir = await fs.open(parent, C.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      return { ...output(file, await current(file)), backupSha256 };
    }); },
    diff({ actor, id } = {}) { return enqueue(async () => { await authorize(actor, 'diff'); await validateSources(); await validateState(); const file = find(id), baseline = baselines.get(id); const before = decode(await readBackup(id, baseline.baselineSha256)); const after = await current(file); return { id, fromSha256: baseline.baselineSha256, toSha256: after.sha256, changes: diffMarkdown(before, after.content) }; }); },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await chain;
        try {
          const st = await statNoLink(lockPath), own = await lockHandle.stat();
          if (st.dev !== own.dev || st.ino !== own.ino) throw fail('LOCK_OWNERSHIP_LOST');
          if ((await readFile(lockPath, 128, 0o600)).toString() !== lockToken) throw fail('LOCK_OWNERSHIP_LOST');
          await fs.unlink(lockPath); closed = true;
        } finally { await lockHandle.close().catch(() => {}); }
      })();
      return closePromise;
    },
  };
  return Object.freeze(api);
}
