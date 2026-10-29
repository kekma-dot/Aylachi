import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSourceWorkbench } from './store.mjs';

const marker = 'aylachi-source-workbench-v1\n';
const linux = process.platform === 'linux';
const bindings = [{ id: 'sample', path: 'src/sample.mjs' }];
async function lab(t, content = 'const value = 1;\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-workbench-'));
  const labRoot = path.join(root, 'lab'), checkout = path.join(labRoot, 'checkout');
  await fs.mkdir(checkout, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(checkout, 'src'), { mode: 0o755 });
  await fs.chmod(checkout, 0o700);
  await fs.chmod(labRoot, 0o700);
  await fs.writeFile(path.join(labRoot, '.aylachi-source-lab'), marker, { mode: 0o600 });
  await fs.writeFile(path.join(checkout, bindings[0].path), content, { mode: 0o644 });
  await fs.chmod(path.join(checkout, bindings[0].path), 0o644);
  return labRoot;
}
const open = (labRoot, overrides = {}) => openSourceWorkbench({ labRoot, files: bindings, forbiddenRoots: [], authorize: async () => true, ...overrides });
const sha = s => import('node:crypto').then(({ createHash }) => createHash('sha256').update(s).digest('hex'));

if (linux) {
test('read, save, verified backup, diff and reopen preserve baseline', async t => {
  const labRoot = await lab(t), store = await open(labRoot);
  const before = await store.read({ actor: 'ui', id: 'sample' });
  const saved = await store.save({ actor: 'ui', id: 'sample', content: 'const value = 2;\n', expectedSha256: before.sha256 });
  assert.equal(saved.backupSha256, before.sha256);
  const backupDirs = await fs.readdir(path.join(labRoot, '.workbench', 'backups', 'sample'));
  assert.equal(backupDirs.length, 1);
  const oldBackup = path.join(labRoot, '.workbench', 'backups', 'sample', `${before.sha256}.utf8`);
  assert.equal(await fs.readFile(oldBackup, 'utf8'), before.content);
  assert.deepEqual(await store.diff({ actor: 'ui', id: 'sample' }), { id: 'sample', fromSha256: await sha(before.content), toSha256: saved.sha256, changes: [{ start: 0, remove: [before.content], insert: [saved.content] }] });
  await store.close();
  const reopened = await open(labRoot);
  assert.equal((await reopened.read({ actor: 'ui', id: 'sample' })).baselineSha256, before.baselineSha256);
  await reopened.close();
});

test('preserves a UTF-8 BOM through read, edit, and diff', async t => {
  const labRoot = await lab(t, '\uFEFFfirst\n');
  const store = await open(labRoot);
  const before = await store.read({ actor: 'ui', id: 'sample' });
  assert.equal(before.content, '\uFEFFfirst\n');
  const saved = await store.save({ actor: 'ui', id: 'sample', content: '\uFEFFsecond\n', expectedSha256: before.sha256 });
  assert.equal(saved.content, '\uFEFFsecond\n');
  assert.equal((await store.diff({ actor: 'ui', id: 'sample' })).changes[0].remove[0], '\uFEFFfirst\n');
  await store.close();
});

test('stale expected hash makes no source or backup change; denied calls do no read', async t => {
  const labRoot = await lab(t), store = await open(labRoot);
  const source = path.join(labRoot, 'checkout', bindings[0].path), before = await fs.readFile(source);
  const backups = async () => (await fs.readdir(path.join(labRoot, '.workbench', 'backups'))).sort();
  const beforeDirs = await backups();
  await assert.rejects(store.save({ actor: 'ui', id: 'sample', content: 'new\n', expectedSha256: '0'.repeat(64) }), { code: 'CONFLICT' });
  assert.deepEqual(await fs.readFile(source), before); assert.deepEqual(await backups(), beforeDirs);
  await store.close();
  const otherLab = await lab(t);
  const denied = await open(otherLab, { authorize: async () => false });
  await assert.rejects(denied.read({ actor: 'x', id: 'sample' }), { code: 'POLICY_DENIED' });
  await denied.close();
});

test('invalid bindings and accessor config fail before state creation without invoking getter', async t => {
  const labRoot = await lab(t); let calls = 0;
  const files = [{ id: 'sample', path: 'src/sample.mjs' }];
  Object.defineProperty(files[0], 'path', { enumerable: true, get() { calls++; throw Error('getter'); } });
  await assert.rejects(open(labRoot, { files }), { code: 'INVALID_FILE_BINDING' });
  assert.equal(calls, 0); await assert.rejects(fs.stat(path.join(labRoot, '.workbench')), { code: 'ENOENT' });
  await assert.rejects(open(labRoot, { files: [{ id: 'x', path: '../secret.mjs' }] }));
});

test('lock excludes a second owner, concurrent saves serialize, and close releases it', async t => {
  const labRoot = await lab(t), first = await open(labRoot);
  await assert.rejects(open(labRoot), { code: 'WORKBENCH_LOCKED' });
  const before = await first.read({ actor: 'ui', id: 'sample' });
  const saves = await Promise.allSettled([
    first.save({ actor: 'ui', id: 'sample', content: 'one\\n', expectedSha256: before.sha256 }),
    first.save({ actor: 'ui', id: 'sample', content: 'two\\n', expectedSha256: before.sha256 }),
  ]);
  assert.equal(saves.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(saves.filter(r => r.status === 'rejected' && r.reason.code === 'CONFLICT').length, 1);
  const closing = first.close();
  await assert.rejects(first.read({ actor: 'ui', id: 'sample' }), { code: 'CLOSED' });
  await closing; await first.close();
  const second = await open(labRoot); await second.close();
});

test('rejects unsafe source before creating state and preserves symlinked ancestors', async t => {
  const labRoot = await lab(t), checkout = path.join(labRoot, 'checkout');
  const outside = path.join(path.dirname(labRoot), 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(path.join(outside, 'sample.mjs'), 'outside\\n', { mode: 0o600 });
  await fs.rm(path.join(checkout, 'src'), { recursive: true });
  await fs.symlink(outside, path.join(checkout, 'src'));
  await assert.rejects(open(labRoot), { code: 'SYMLINK' });
  await assert.rejects(fs.stat(path.join(labRoot, '.workbench')), { code: 'ENOENT' });
});

test('rejects invalid UTF-8, oversized files, and hard links before state creation', async t => {
  for (const data of [Buffer.from([0xff]), Buffer.alloc(32 * 1024 + 1, 0x61)]) {
    const labRoot = await lab(t); await fs.writeFile(path.join(labRoot, 'checkout', bindings[0].path), data, { mode: 0o600 });
    await assert.rejects(open(labRoot));
    await assert.rejects(fs.stat(path.join(labRoot, '.workbench')), { code: 'ENOENT' });
  }
  const labRoot = await lab(t), source = path.join(labRoot, 'checkout', bindings[0].path);
  await fs.link(source, path.join(labRoot, 'checkout', 'copy.mjs'));
  await assert.rejects(open(labRoot));
  await assert.rejects(fs.stat(path.join(labRoot, '.workbench')), { code: 'ENOENT' });
});

test('rejects lexical forbidden overlap without resolving protected path', async t => {
  const labRoot = await lab(t);
  await assert.rejects(open(labRoot, { forbiddenRoots: [labRoot] }), { code: 'FORBIDDEN_ROOT_OVERLAP' });
  await assert.rejects(open(labRoot, { forbiddenRoots: [path.dirname(labRoot)] }), { code: 'FORBIDDEN_ROOT_OVERLAP' });
  await assert.rejects(open(labRoot, { forbiddenRoots: ['/'] }), { code: 'FORBIDDEN_ROOT_OVERLAP' });
  await assert.rejects(fs.stat(path.join(labRoot, '.workbench')), { code: 'ENOENT' });
});

test('rejects lab-root and marker symlinks', async t => {
  const labRoot = await lab(t), parent = path.dirname(labRoot), link = path.join(parent, 'lab-link');
  await fs.symlink(labRoot, link);
  await assert.rejects(open(link));
  const markerPath = path.join(labRoot, '.aylachi-source-lab');
  await fs.rename(markerPath, `${markerPath}.held`);
  await fs.symlink(`${markerPath}.held`, markerPath);
  await assert.rejects(open(labRoot), { code: 'SYMLINK' });
});

test('lost lock token is retained and operations are refused after close attempt', async t => {
  const labRoot = await lab(t), store = await open(labRoot), lockPath = path.join(labRoot, '.workbench', 'lock');
  const lockBefore = await fs.stat(lockPath);
  const descriptors = await fs.readdir('/proc/self/fd');
  const before = await Promise.all(descriptors.map(fd => fs.readlink(`/proc/self/fd/${fd}`).catch(() => '')));
  assert.ok(before.includes(lockPath));
  await fs.writeFile(lockPath, 'foreign-owner');
  await assert.rejects(store.close(), { code: 'LOCK_OWNERSHIP_LOST' });
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'foreign-owner');
  await assert.rejects(store.read({ actor: 'ui', id: 'sample' }), { code: 'CLOSED' });
  const afterFds = await fs.readdir('/proc/self/fd');
  const after = await Promise.all(afterFds.map(fd => fs.readlink(`/proc/self/fd/${fd}`).catch(() => '')));
  assert.ok(!after.includes(lockPath));
  assert.ok(lockBefore.ino > 0);
});

test('missing or corrupt baseline backup fails during open and releases the owned lock', async t => {
  for (const corrupt of [false, true]) {
    const labRoot = await lab(t), store = await open(labRoot); await store.close();
    const manifest = JSON.parse(await fs.readFile(path.join(labRoot, '.workbench', 'manifest.json'), 'utf8'));
    const backup = path.join(labRoot, '.workbench', 'backups', 'sample', `${manifest.files[0].baselineSha256}.utf8`);
    if (corrupt) await fs.writeFile(backup, 'corrupt\\n', { mode: 0o600 }); else await fs.unlink(backup);
    await assert.rejects(open(labRoot));
    await assert.rejects(fs.stat(path.join(labRoot, '.workbench', 'lock')), { code: 'ENOENT' });
  }
});

test('partial state and corrupt manifest fail closed without re-baselining', async t => {
  const labRoot = await lab(t), state = path.join(labRoot, '.workbench');
  await fs.mkdir(state, { mode: 0o700 }); await fs.mkdir(path.join(state, 'backups'), { mode: 0o700 });
  await assert.rejects(open(labRoot), { code: 'PARTIAL_STATE' });
  await fs.writeFile(path.join(state, 'manifest.json'), '{broken', { mode: 0o600 });
  await assert.rejects(open(labRoot), { code: 'INVALID_MANIFEST' });
});

test('backup parent symlink fails without following it', async t => {
  const labRoot = await lab(t), store = await open(labRoot); await store.close();
  const backupRoot = path.join(labRoot, '.workbench', 'backups');
  await fs.rename(backupRoot, `${backupRoot}.held`);
  await fs.symlink(path.dirname(labRoot), backupRoot);
  await assert.rejects(open(labRoot), { code: 'SYMLINK' });
});
} else {
  test('platform durability gate precedes filesystem access', async () => {
    await assert.rejects(open('/path/that/does/not/exist'), { code: 'LINUX_DURABILITY_REQUIRED' });
  });
}
