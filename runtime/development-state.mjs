import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

export const ROOT_MARKER = '.aylachi-dev-root';
export const ADDRESS_NAME = '.server-address';
export const BEARER_NAME = '.bearer';
const LOCK_NAME = '.server.lock';
const LIVE_USED_NAME = '.live-used';
const DEFAULT_AUTH_PATH = '/home/ayla/.pi/agent/auth.json'; // Official SDK getAgentDir() default on Ayla.
const TOKEN = /^[a-f0-9]{64}$/;
const MARKER_CONTENT = 'aylachi-development-state-v1\n';
const knownRootEntries = new Set([
  ROOT_MARKER, LOCK_NAME, ADDRESS_NAME, BEARER_NAME, LIVE_USED_NAME,
  'core.sqlite', 'core.sqlite-journal', 'core.sqlite-shm', 'core.sqlite-wal',
  'handoff.sqlite', 'handoff.sqlite-journal', 'handoff.sqlite-shm', 'handoff.sqlite-wal',
  'delegation.sqlite', 'delegation.sqlite-journal', 'delegation.sqlite-shm', 'delegation.sqlite-wal',
  'tool-effects.sqlite', 'tool-effects.sqlite-journal', 'tool-effects.sqlite-shm', 'tool-effects.sqlite-wal',
  'workspace-graph.sqlite', 'workspace-graph.sqlite-journal', 'workspace-graph.sqlite-shm', 'workspace-graph.sqlite-wal',
  'artifacts.sqlite', 'artifacts.sqlite-journal', 'artifacts.sqlite-shm', 'artifacts.sqlite-wal',
  'backends.sqlite', 'backends.sqlite-journal', 'backends.sqlite-shm', 'backends.sqlite-wal',
  'channels.sqlite', 'channels.sqlite-journal', 'channels.sqlite-shm', 'channels.sqlite-wal',
  'memory.sqlite', 'memory.sqlite-journal', 'memory.sqlite-shm', 'memory.sqlite-wal',
  'browser.sqlite', 'browser.sqlite-journal', 'browser.sqlite-shm', 'browser.sqlite-wal',
  'themes.sqlite', 'themes.sqlite-journal', 'themes.sqlite-shm', 'themes.sqlite-wal',
  'satellite.sqlite', 'satellite.sqlite-journal', 'satellite.sqlite-shm', 'satellite.sqlite-wal',
  'wiki', 'pi', 'workspace', 'live-budget.json', '.restored-session-files.json',
]);

const coded = (code, exitCode = 1) => Object.assign(new Error(code), { code, exitCode });
const inside = (path, parent) => path === parent || path.startsWith(`${parent}${sep}`);
const modePrivate = stat => (stat.mode & 0o077) === 0;
const uid = () => typeof process.getuid === 'function' ? process.getuid() : null;

export function assertCanonicalAbsolute(path, code) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === parse(path).root || path.includes('\0')) throw coded(code, 64);
  return path;
}

function forbiddenRoot(path) {
  const home = resolve(process.env.HOME || homedir());
  const forbidden = [
    join(home, '.pi'),
    join(home, 'BAZA'),
    join(home, 'Documents', 'BAZA'),
    '/srv/aylachi/baza',
    '/srv/aylachi/coding-repos/aylachi/.pi',
  ].map(item => resolve(item));
  return path === home || inside(home, path) || forbidden.some(item => inside(path, item) || inside(item, path));
}

async function inspectPath(path, { create = false } = {}) {
  const absolute = assertCanonicalAbsolute(path, 'INVALID_STATE_ROOT');
  if (forbiddenRoot(absolute)) throw coded('UNSAFE_STATE_ROOT', 64);
  const components = absolute.slice(parse(absolute).root.length).split(sep).filter(Boolean);
  let current = parse(absolute).root;
  for (const component of components) {
    current = join(current, component);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw coded('STATE_ROOT_UNAVAILABLE', 64);
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw coded('STATE_ROOT_UNAVAILABLE', 64); }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded('UNSAFE_STATE_PATH', 64);
  }
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid() !== null && stat.uid !== uid()) || !modePrivate(stat) || (stat.mode & 0o700) !== 0o700) throw coded('UNSAFE_STATE_ROOT', 64);
  return absolute;
}

export async function privateRegular(path, { required = true, maxMode = 0o600 } = {}) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT' && !required) return null; throw coded('STATE_FILE_UNAVAILABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (uid() !== null && stat.uid !== uid()) || (stat.mode & 0o777) > maxMode) throw coded('UNSAFE_STATE_FILE');
  return stat;
}

export async function readPrivate(path, maxBytes = 4096) {
  const before = await privateRegular(path);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw coded('UNSAFE_STATE_FILE'); }
  try {
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || (uid() !== null && after.uid !== uid()) || !modePrivate(after) || after.size > maxBytes) throw coded('UNSAFE_STATE_FILE');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function writeExclusive(path, text, mode = 0o600) {
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode); }
  catch (error) { if (error.code === 'EEXIST') return false; throw coded('STATE_WRITE_FAILED'); }
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  catch { await handle.close(); throw coded('STATE_WRITE_FAILED'); }
  await handle.close();
  return true;
}

export async function initializeRoot(root) {
  await inspectPath(root, { create: true });
  const markerPath = join(root, ROOT_MARKER);
  let marker;
  try { marker = await readPrivate(markerPath, 128); }
  catch (error) {
    if (error.code !== 'STATE_FILE_UNAVAILABLE') throw error;
    const entries = await readdir(root);
    if (entries.length !== 0) throw coded('UNOWNED_STATE_ROOT', 64);
    if (!await writeExclusive(markerPath, MARKER_CONTENT)) throw coded('UNOWNED_STATE_ROOT', 64);
    marker = MARKER_CONTENT;
  }
  if (marker !== MARKER_CONTENT) throw coded('UNOWNED_STATE_ROOT', 64);
  const entries = await readdir(root);
  if (entries.some(name => !knownRootEntries.has(name))) throw coded('UNOWNED_STATE_ROOT', 64);
  return root;
}

export async function validateRoot(root) {
  await inspectPath(root);
  const marker = await readPrivate(join(root, ROOT_MARKER), 128);
  if (marker !== MARKER_CONTENT) throw coded('UNOWNED_STATE_ROOT', 64);
  const entries = await readdir(root);
  if (entries.some(name => !knownRootEntries.has(name))) throw coded('UNOWNED_STATE_ROOT', 64);
  return root;
}

export async function withOfflineDevelopmentState(root, callback) {
  if (typeof callback !== 'function') throw coded('INVALID_CALLBACK', 64);
  const trustedRoot = await validateRoot(root);
  const lock = await acquireLock(trustedRoot);
  try { return await callback(trustedRoot); }
  finally { await releaseLock(lock); }
}

export async function ensurePrivateDir(path) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw coded('STATE_WRITE_FAILED'); }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid() !== null && stat.uid !== uid()) || !modePrivate(stat) || (stat.mode & 0o700) !== 0o700) throw coded('UNSAFE_STATE_PATH');
}

export async function ensureDatabaseFile(path) {
  const existing = await privateRegular(path, { required: false });
  if (existing) return;
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if (error.code === 'EEXIST') return ensureDatabaseFile(path); throw coded('STATE_WRITE_FAILED'); }
  await handle.sync();
  await handle.close();
}

export async function acquireLock(root) {
  const path = join(root, LOCK_NAME), token = randomUUID();
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw coded('STATE_LOCKED', 64); throw coded('STATE_LOCK_FAILED'); }
  const content = `${process.pid} ${token}\n`;
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  catch { await handle.close(); throw coded('STATE_LOCK_FAILED'); }
  return { path, handle, content, dev: (await handle.stat()).dev, ino: (await handle.stat()).ino };
}

export async function releaseLock(lock) {
  const opened = await lock.handle.stat();
  if (opened.dev !== lock.dev || opened.ino !== lock.ino) throw coded('LOCK_OWNERSHIP_LOST');
  const text = await readPrivate(lock.path, 256);
  if (text !== lock.content) throw coded('LOCK_OWNERSHIP_LOST');
  const current = await lstat(lock.path);
  if (current.dev !== lock.dev || current.ino !== lock.ino || current.isSymbolicLink()) throw coded('LOCK_OWNERSHIP_LOST');
  await lock.handle.close();
  await unlink(lock.path);
}

export async function ensureBearer(root) {
  const path = join(root, BEARER_NAME);
  const existing = await privateRegular(path, { required: false });
  if (existing) {
    const saved = await readPrivate(path, 128);
    if (saved.length !== 65 || saved.charCodeAt(64) !== 10 || !TOKEN.test(saved.slice(0, 64))) throw coded('BEARER_FILE_INVALID');
    return saved.slice(0, 64);
  }
  const token = randomBytes(32).toString('hex');
  if (!await writeExclusive(path, `${token}\n`)) return ensureBearer(root);
  return token;
}

export async function writeAddress(root, port) {
  const path = join(root, ADDRESS_NAME);
  await privateRegular(path, { required: false });
  if (!knownRootEntries.has(ADDRESS_NAME)) throw coded('STATE_WRITE_FAILED');
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch { throw coded('STATE_WRITE_FAILED'); }
  try { await handle.writeFile(`${port}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  return { path, content: `${port}\n` };
}

export async function removeAddress(address) {
  if (!address) return;
  const current = await privateRegular(address.path, { required: false });
  if (!current) return;
  const value = await readPrivate(address.path, 64);
  if (value !== address.content) throw coded('ADDRESS_OWNERSHIP_LOST');
  await unlink(address.path);
}

export async function consumeLiveApproval(root) {
  const budgetPath = join(root, 'live-budget.json');
  const existingBudget = await privateRegular(budgetPath, { required: false });
  if (existingBudget) throw coded('LIVE_APPROVAL_ALREADY_CONSUMED', 64);
  if (!await writeExclusive(join(root, LIVE_USED_NAME), `${Date.now()}\n`)) throw coded('LIVE_APPROVAL_ALREADY_CONSUMED', 64);
}

export async function trustedSdkRoot(value) {
  const path = assertCanonicalAbsolute(value, 'INVALID_SDK_ROOT');
  let actual;
  try { actual = await realpath(path); } catch { throw coded('INVALID_SDK_ROOT', 64); }
  const stat = await lstat(actual);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw coded('INVALID_SDK_ROOT', 64);
  return actual;
}

export async function trustedAuthPath(value = process.env.AYLACHI_DEV_AUTH_PATH ?? DEFAULT_AUTH_PATH) {
  const path = assertCanonicalAbsolute(value, 'AUTH_PATH_INVALID');
  // Metadata only: never open, read, copy, or log auth contents.
  let stat;
  try { stat = await lstat(path); } catch { throw coded('AUTH_PATH_UNAVAILABLE', 64); }
  if (!stat.isFile() || stat.isSymbolicLink() || (uid() !== null && stat.uid !== uid()) || !modePrivate(stat) || (stat.mode & 0o111) !== 0) {
    throw coded('AUTH_PATH_UNSAFE', 64);
  }
  return path;
}
