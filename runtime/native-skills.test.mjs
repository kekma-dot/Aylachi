import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { prepareNativeSkills, snapshotNativeSkillBindings } from './native-skills.mjs';

const denied = error => error?.code === 'NATIVE_SKILLS_INVALID';
const skill = (name = 'planner', content = '# Planner\n') => ({ name, description: 'A bounded synthetic skill.', content });
const binding = (skills = [skill()], sessionId = 'session-a', cardId = 'card-a') => ({ cardId, sessionId, skills });
const digest = content => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
const target = (workspace, sessionId, content) => join(workspace, '.aylachi-skills', sessionId, digest(content));

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-skills-')));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  await chmod(workspace, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace };
}

async function privateTree(workspace, directory) {
  const rel = relative(workspace, directory);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('test path escaped workspace');
  let current = workspace;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    await chmod(current, 0o700);
  }
}

test('snapshot validates plain data, limits and uniqueness without invoking accessors', () => {
  const source = [binding()];
  const snapshot = snapshotNativeSkillBindings(source);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot[0]) && Object.isFrozen(snapshot[0].skills) && Object.isFrozen(snapshot[0].skills[0]));
  source[0].skills[0].content = 'mutated';
  assert.equal(snapshot[0].skills[0].content, '# Planner\n');
  assert.deepEqual(snapshotNativeSkillBindings([]), []);

  let reads = 0;
  const accessorSkill = { name: 'planner', description: 'Valid', get content() { reads++; throw Error('getter'); } };
  assert.throws(() => snapshotNativeSkillBindings([binding([accessorSkill])]), denied);
  assert.equal(reads, 0);
  const accessorArray = [];
  Object.defineProperty(accessorArray, '0', { enumerable: true, get() { reads++; throw Error('getter'); } });
  accessorArray.length = 1;
  assert.throws(() => snapshotNativeSkillBindings([binding(accessorArray)]), denied);
  assert.equal(reads, 0);

  const invalidInputs = [
    [binding([skill('Upper')])],
    [binding([skill(), skill()])],
    [binding([], 'session-a')],
    [binding([skill()], 'session-a'), binding([skill()], 'session-a', 'card-b')],
    [binding([skill()], 'session-a', 'card-a'), binding([skill()], 'session-b', 'card-a')],
    [binding([skill('planner', 'é'.repeat(8_193))])],
    [binding([skill('planner', 'x'.repeat(11_000)), skill('reviewer', 'y'.repeat(11_000)), skill('writer', 'z'.repeat(11_000))])],
    [binding([skill('planner', 'ok')])],
    [binding([skill('planner'), skill('reviewer'), skill('writer'), skill('fourth')])],
    [binding([skill()], 'session-a', 'card-a'), binding([skill()], 'session-b', 'card-b'), binding([skill()], 'session-c', 'card-c'), binding([skill()], 'session-d', 'card-d')],
  ];
  invalidInputs[7][0].skills[0].description = 'x'.repeat(501);
  invalidInputs[8][0].skills[0].name = 'bad name';
  for (const input of invalidInputs) assert.throws(() => snapshotNativeSkillBindings(input), denied);
  assert.throws(() => snapshotNativeSkillBindings(new Array(1)), denied);
  assert.throws(() => snapshotNativeSkillBindings([Object.assign(Object.create({ inherited: true }), binding())]), denied);
  assert.throws(() => snapshotNativeSkillBindings([Object.assign(binding(), { sourcePath: '/tmp/evil' })]), denied);
  const symbolBinding = binding();
  symbolBinding[Symbol('extra')] = true;
  assert.throws(() => snapshotNativeSkillBindings([symbolBinding]), denied);
  const customArray = [binding()];
  customArray.extra = true;
  assert.throws(() => snapshotNativeSkillBindings(customArray), denied);
  const customPrototype = [binding()];
  Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
  assert.throws(() => snapshotNativeSkillBindings(customPrototype), denied);
  assert.throws(() => snapshotNativeSkillBindings([binding([skill('planner', '   ')])]), denied);
});

test('description bounds distinguish UTF-16 input size from trimmed Unicode code points', () => {
  const selected = description => [binding([{ ...skill(), description }])];
  assert.equal(snapshotNativeSkillBindings(selected('😀'.repeat(500)))[0].skills[0].description.length, 1000);
  assert.throws(() => snapshotNativeSkillBindings(selected('😀'.repeat(501))), denied);
  assert.throws(() => snapshotNativeSkillBindings(selected(' '.repeat(1000) + 'x')), denied);
});

test('prepare stages exact private bytes, returns frozen SDK metadata, and reuses matching files', async t => {
  const { root, workspace } = await fixture(t);
  const input = [binding([skill('planner', '# Exact\n```js\nnot executed\n```\n'), skill('reviewer', 'Review body\n')])];
  const metadata = await prepareNativeSkills({ workspace, bindings: input });
  const entries = metadata['session-a'];
  assert.ok(Object.isFrozen(metadata) && Object.isFrozen(entries) && Object.isFrozen(entries[0]) && Object.isFrozen(entries[0].sourceInfo));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'planner');
  assert.equal(entries[0].disableModelInvocation, true);
  assert.deepEqual(entries[0].sourceInfo, { scope: 'project', path: entries[0].filePath });
  assert.equal('content' in entries[0], false);
  assert.equal(entries[0].baseDir, target(workspace, 'session-a', input[0].skills[0].content));
  const bytes = Buffer.from(input[0].skills[0].content, 'utf8');
  assert.deepEqual(await readFile(entries[0].filePath), bytes);
  const stagedStat = await stat(entries[0].filePath);
  assert.equal(stagedStat.mode & 0o7777, 0o600);
  assert.equal(stagedStat.nlink, 1);
  assert.equal(stagedStat.uid, process.getuid());
  assert.equal(entries[0].filePath, join(entries[0].baseDir, 'SKILL.md'));
  assert.deepEqual(await readdir(root), ['workspace']);

  const again = await prepareNativeSkills({ workspace, bindings: snapshotNativeSkillBindings(input) });
  assert.equal((await stat(entries[0].filePath)).ino, stagedStat.ino);
  assert.deepEqual(again['session-a'][0], entries[0]);
  assert.equal(digest(await readFile(entries[0].filePath, 'utf8')), digest(input[0].skills[0].content));
});

test('rejects public workspaces and public managed ancestors without relaxing them', async t => {
  const { workspace } = await fixture(t);
  await chmod(workspace, 0o755);
  await assert.rejects(prepareNativeSkills({ workspace, bindings: [binding()] }), denied);
  assert.deepEqual(await readdir(workspace), []);

  await chmod(workspace, 0o700);
  const skillsRoot = join(workspace, '.aylachi-skills');
  await mkdir(skillsRoot, { mode: 0o755 });
  await chmod(skillsRoot, 0o755);
  await assert.rejects(prepareNativeSkills({ workspace, bindings: [binding()] }), denied);
  assert.equal((await stat(skillsRoot)).mode & 0o7777, 0o755);
});

test('rejects workspace and staging symlinks without writing through them', async t => {
  const { root, workspace } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside, { mode: 0o700 });
  const workspaceLink = join(root, 'workspace-link');
  await symlink(workspace, workspaceLink);
  await assert.rejects(prepareNativeSkills({ workspace: workspaceLink, bindings: [binding()] }), denied);
  await symlink(outside, join(workspace, '.aylachi-skills'));
  await assert.rejects(prepareNativeSkills({ workspace, bindings: [binding()] }), denied);
  assert.deepEqual(await readdir(outside), []);
});

test('rejects linked, public, or conflicting existing SKILL.md and preserves all existing bytes', async t => {
  const { root, workspace } = await fixture(t);
  const content = '# Expected\n';
  const filePath = join(target(workspace, 'session-a', content), 'SKILL.md');
  await privateTree(workspace, join(filePath, '..'));

  const linked = join(root, 'linked.md');
  await writeFile(linked, content, { mode: 0o600 });
  await symlink(linked, filePath);
  await assert.rejects(prepareNativeSkills({ workspace, bindings: [binding([skill('planner', content)])] }), denied);
  assert.equal(await readFile(linked, 'utf8'), content);
  await rm(filePath);

  await writeFile(filePath, content, { mode: 0o644 });
  await chmod(filePath, 0o644);
  await assert.rejects(prepareNativeSkills({ workspace, bindings: [binding([skill('planner', content)])] }), denied);
  assert.equal((await stat(filePath)).mode & 0o7777, 0o644);
  await rm(filePath);

  const outsideHardlink = join(root, 'hardlink-source.md');
  await writeFile(outsideHardlink, content, { mode: 0o600 });
  await chmod(outsideHardlink, 0o600);
  await link(outsideHardlink, filePath);
  await assert.rejects(prepareNativeSkills({ workspace, bindings: [binding([skill('planner', content)])] }), denied);
  assert.equal((await stat(filePath)).nlink, 2);
  assert.equal(await readFile(outsideHardlink, 'utf8'), content);
  await rm(filePath);

  const wrong = 'conflicting bytes';
  await writeFile(filePath, wrong, { mode: 0o600 });
  await chmod(filePath, 0o600);
  await assert.rejects(prepareNativeSkills({ workspace, bindings: [binding([skill('planner', content)])] }), denied);
  assert.equal(await readFile(filePath, 'utf8'), wrong);
});

test('skill lookup has no inherited session entries', async t => {
  const { workspace } = await fixture(t);
  const prepared = await prepareNativeSkills({ workspace, bindings: [binding()] });
  assert.equal(Object.getPrototypeOf(prepared), null);
  assert.equal(prepared.constructor, undefined);
  assert.equal(prepared.toString, undefined);
  assert.equal(prepared['session-a'].length, 1);
});

test('failure preserves earlier staged output and the conflicting file', async t => {
  const { workspace } = await fixture(t);
  const first = skill('planner', 'first complete file\n');
  const second = skill('reviewer', 'second expected file\n');
  const conflict = join(target(workspace, 'session-a', second.content), 'SKILL.md');
  await privateTree(workspace, join(conflict, '..'));
  await writeFile(conflict, 'pre-existing conflicting bytes', { mode: 0o600 });
  await chmod(conflict, 0o600);

  await assert.rejects(prepareNativeSkills({ workspace, bindings: [binding([first, second])] }), denied);
  const firstPath = join(target(workspace, 'session-a', first.content), 'SKILL.md');
  assert.equal(await readFile(firstPath, 'utf8'), first.content);
  assert.equal(await readFile(conflict, 'utf8'), 'pre-existing conflicting bytes');
});
