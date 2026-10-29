import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, link, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RESTORED_SESSION_FILES_NAME, loadRestoredSessionFiles } from './restored-session-files.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-restored-map-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const record = JSON.stringify({ format: 1, sessions: { alpha: '2026-10-22T18-31-00-123Z_123e4567-e89b-42d3-a456-426614174000.jsonl' } });
const invalidCode = { code: 'RESTORED_SESSION_FILES_INVALID' };

test('absence after root validation and valid immutable map', async t => {
  const root = await fixture(t);
  assert.equal(await loadRestoredSessionFiles(root), undefined);
  await writeFile(join(root, RESTORED_SESSION_FILES_NAME), record, { mode: 0o600 });
  const map = await loadRestoredSessionFiles(root);
  assert.equal(map.alpha, JSON.parse(record).sessions.alpha);
  assert.equal(Object.isFrozen(map), true);
  assert.throws(() => { map.alpha = 'changed'; }, TypeError);
});

test('strict envelope, JSON and map validation', async t => {
  const root = await fixture(t), path = join(root, RESTORED_SESSION_FILES_NAME);
  for (const bad of ['{', JSON.stringify({ format: 1, sessions: {}, extra: true }), JSON.stringify({ format: 2, sessions: {} }), JSON.stringify({ format: 1, sessions: { '../x': 'file.jsonl' } }), JSON.stringify({ format: 1, sessions: { a: '../file.jsonl' } })]) {
    await writeFile(path, bad, { mode: 0o600 });
    await assert.rejects(loadRestoredSessionFiles(root), invalidCode);
  }
});

test('size, mode, symlink, hardlink and root permissions fail closed', async t => {
  const root = await fixture(t), path = join(root, RESTORED_SESSION_FILES_NAME);
  await writeFile(path, 'x'.repeat(32_769), { mode: 0o600 });
  await assert.rejects(loadRestoredSessionFiles(root), invalidCode);
  await rm(path);
  await writeFile(path, record, { mode: 0o644 });
  await assert.rejects(loadRestoredSessionFiles(root), invalidCode);
  await chmod(path, 0o600);
  const hard = join(root, 'hardlink'); await link(path, hard);
  await assert.rejects(loadRestoredSessionFiles(root), invalidCode);
  await rm(hard); await rm(path);
  await symlink(join(root, 'absent'), path);
  await assert.rejects(loadRestoredSessionFiles(root), invalidCode);
  const badRoot = await fixture(t); await chmod(badRoot, 0o755);
  assert.equal((await loadRestoredSessionFiles(badRoot).catch(error => error.code)), 'RESTORED_SESSION_FILES_INVALID');
});
