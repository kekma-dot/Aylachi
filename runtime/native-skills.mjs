import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

const invalid = () => Object.assign(new Error('NATIVE_SKILLS_INVALID'), { code: 'NATIVE_SKILLS_INVALID' });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const skillName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function dataRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || keys.some(key => !own.includes(key))) throw invalid();
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
    return descriptor.value;
  });
}

function wellFormed(value) {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

export function snapshotNativeSkillBindings(value) {
  try {
    const sessions = new Set(), cards = new Set();
    const bindings = denseArray(value, 3).map(item => {
      const binding = dataRecord(item, ['cardId', 'sessionId', 'skills']);
      if (!identifier(binding.cardId) || !identifier(binding.sessionId) ||
          cards.has(binding.cardId) || sessions.has(binding.sessionId)) throw invalid();
      const names = new Set();
      const skills = denseArray(binding.skills, 3).map(raw => {
        const skill = dataRecord(raw, ['name', 'description', 'content']);
        // Bound UTF-16 input before counting trimmed Unicode code points (500 may use 1000 units).
        const descriptionLength = typeof skill.description === 'string' && skill.description.length <= 1_000
          ? [...skill.description.trim()].length : 0;
        if (!skillName(skill.name) || names.has(skill.name) || !descriptionLength || descriptionLength > 500 ||
            !wellFormed(skill.description) || typeof skill.content !== 'string' || skill.content.length > 16_384 ||
            !skill.content.trim() || !wellFormed(skill.content)) throw invalid();
        const contentBytes = Buffer.from(skill.content, 'utf8');
        if (contentBytes.length > 16_384) throw invalid();
        names.add(skill.name);
        return Object.freeze({ name: skill.name, description: skill.description, content: skill.content });
      });
      if (!skills.length) throw invalid();
      cards.add(binding.cardId);
      sessions.add(binding.sessionId);
      return Object.freeze({ cardId: binding.cardId, sessionId: binding.sessionId, skills: Object.freeze(skills) });
    });
    const snapshot = Object.freeze(bindings);
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 32_768) throw invalid();
    return snapshot;
  } catch { throw invalid(); }
}

function ownerUid() {
  if (typeof process.getuid !== 'function') throw invalid();
  return process.getuid();
}

function privateMode(stat, mode) {
  return (stat.mode & 0o7777) === mode;
}

async function assertDirectory(path, { uid, workspace = false } = {}) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || !privateMode(stat, 0o700) || await realpath(path) !== path) throw invalid();
  if (workspace && parse(path).root === path) throw invalid();
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  if (typeof constants.O_DIRECTORY !== 'number' || typeof constants.O_NOFOLLOW !== 'number') throw invalid();
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== uid || !privateMode(opened, 0o700)) throw invalid();
  } finally { await handle.close(); }
}

async function assertCanonicalWorkspace(workspace, uid) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || resolve(workspace) !== workspace || workspace === parse(workspace).root) throw invalid();
  const root = parse(workspace).root;
  let current = root;
  const rootStat = await lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(current) !== current) throw invalid();
  for (const component of workspace.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw invalid();
  }
  await assertDirectory(workspace, { uid, workspace: true });
}

async function ensurePrivateChild(parent, name, uid) {
  await assertDirectory(parent, { uid });
  const path = join(parent, name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw invalid(); }
  await assertDirectory(path, { uid });
  return path;
}

async function verifySkillFile(path, expectedBytes, expectedHash, uid) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== uid ||
      !privateMode(before, 0o600) || before.size !== expectedBytes.length) throw invalid();
  if (typeof constants.O_NOFOLLOW !== 'number') throw invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
        opened.uid !== uid || !privateMode(opened, 0o600) || opened.size !== expectedBytes.length) throw invalid();
    const actual = await handle.readFile();
    const after = await handle.stat();
    const named = await lstat(path);
    if (actual.length !== expectedBytes.length || hash(actual) !== expectedHash || !actual.equals(expectedBytes) ||
        after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || after.uid !== uid ||
        !privateMode(after, 0o600) || after.size !== expectedBytes.length ||
        named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== 1 || named.uid !== uid ||
        !privateMode(named, 0o600) || !named.isFile() || named.isSymbolicLink()) throw invalid();
  } finally { await handle.close(); }
}

// Staging verifies bytes at worker preparation, not every SDK read; it is not same-UID isolation.
async function stageSkill(workspace, sessionId, skill, uid) {
  const bytes = Buffer.from(skill.content, 'utf8');
  const digest = hash(bytes);
  const skillsRoot = await ensurePrivateChild(workspace, '.aylachi-skills', uid);
  const sessionRoot = await ensurePrivateChild(skillsRoot, sessionId, uid);
  const skillRoot = await ensurePrivateChild(sessionRoot, digest, uid);
  const filePath = join(skillRoot, 'SKILL.md');
  let handle;
  try {
    handle = await open(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0), 0o600);
  } catch (error) { if (error?.code !== 'EEXIST') throw invalid(); }
  if (handle) {
    try {
      const created = await handle.stat();
      if (!created.isFile() || created.nlink !== 1 || created.uid !== uid || !privateMode(created, 0o600) || created.size !== 0) throw invalid();
      await handle.writeFile(bytes);
      const written = await handle.stat();
      if (!written.isFile() || written.nlink !== 1 || written.uid !== uid || !privateMode(written, 0o600) || written.size !== bytes.length) throw invalid();
    } finally { await handle.close(); }
  }
  await assertDirectory(skillRoot, { uid });
  await verifySkillFile(filePath, bytes, digest, uid);
  const entries = await readdir(skillRoot);
  if (entries.length !== 1 || entries[0] !== 'SKILL.md') throw invalid();
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    filePath,
    baseDir: skillRoot,
    disableModelInvocation: true,
    sourceInfo: Object.freeze({ scope: 'project', path: filePath }),
  });
}

export async function prepareNativeSkills(options) {
  try {
    const input = dataRecord(options, ['workspace', 'bindings']);
    const bindings = snapshotNativeSkillBindings(input.bindings);
    const uid = ownerUid();
    await assertCanonicalWorkspace(input.workspace, uid);
    const result = Object.create(null);
    for (const binding of bindings) {
      const staged = [];
      for (const skill of binding.skills) staged.push(await stageSkill(input.workspace, binding.sessionId, skill, uid));
      Object.defineProperty(result, binding.sessionId, { value: Object.freeze(staged), enumerable: true, writable: false, configurable: false });
    }
    return Object.freeze(result);
  } catch { throw invalid(); }
}
