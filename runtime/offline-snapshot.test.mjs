import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, link, chmod, realpath, lstat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startDevelopmentServer } from './server.mjs';
import { restoreDevelopmentState, snapshotDevelopmentState } from './offline-snapshot.mjs';
import { openStore } from '../persistence/store.mjs';
import { openHandoffStore } from '../handoff/store.mjs';
import { openToolEffectStore } from '../delegation/effects.mjs';
import { openArtifactStore } from '../artifact-engine/store.mjs';
import { createArtifactEngine } from '../artifact-engine/engine.mjs';
import { openBackendStore } from '../backends/store.mjs';
import { openChannelStore } from '../channels/store.mjs';
import { openMemoryStore } from '../memory/store.mjs';
import { openWiki } from '../wiki/wiki.mjs';
import { createPiAdapter } from '../agent-host/pi-adapter.mjs';
import { sdk, Type, model, runtime } from '../agent-host/tests/fixture-runtime.mjs';

async function fixture(t) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-l05-'));
  await chmod(parent, 0o700);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'state');
  const app = await startDevelopmentServer({ stateRoot: root, port: 0 });
  const core = openStore(join(root, 'core.sqlite'));
  core.createCard({ id: 'card', canvasId: 'fixture', sessionId: 'session', title: 'synthetic', x: 0, y: 0 });
  core.close();
  const handoff = openHandoffStore(join(root, 'handoff.sqlite')); handoff.close();
  const wiki = await openWiki({ root: join(root, 'wiki'), authorize: async () => true });
  await wiki.create({ actor: 'test', content: 'synthetic wiki fixture' });
  assert.equal((await app.shutdown()).status, 'STOPPED');
  return { parent, root };
}

test('snapshots the actual SDK session layout, preserves source mode and normalizes destination mode', async t => {
  const { parent, root } = await fixture(t), dest = join(parent, 'snapshot');
  const sessionId = 'snapshotSession';
  const adapter = createPiAdapter({ sdk, modelRuntime: runtime(), model, root: join(root, 'pi'), cwd: parent, toolDefinitions: [{ name: 'fixture_echo', label: 'Fixture echo', description: 'Synthetic', parameters: Type.Object({ text: Type.String() }), execute: async (_id, args) => ({ content: [{ type: 'text', text: args.text }] }) }] });
  let result;
  try {
    result = await adapter.prompt(sessionId, 'snapshot fixture prompt');
  } finally {
    await adapter.shutdown();
  }
  const sessionPath = result.nativeSessionFile;
  const sessionRel = sessionPath.slice(root.length + 1);
  assert.match(sessionRel, /^pi\/sessions\/snapshotSession\/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z_[a-f0-9-]{36}\.jsonl$/i);
  const sourceBytes = await readFile(sessionPath), sourceMode = (await lstat(sessionPath)).mode & 0o777;
  assert.equal(sourceMode & 0o600, 0o600);
  assert.equal((await lstat(join(root, 'pi', 'agent'))).mode & 0o777, 0o700);
  const restoredBindings = JSON.stringify({ format: 1, sessions: { snapshotSession: sessionPath.split('/').at(-1) } });
  await writeFile(join(root, '.restored-session-files.json'), restoredBindings, { mode: 0o600 });
  const reopened = await startDevelopmentServer({ stateRoot: root, port: 0 });
  try { assert.equal(reopened.modelStatus, 'disabled'); }
  finally { assert.equal((await reopened.shutdown()).status, 'STOPPED'); }
  const resultSnapshot = await snapshotDevelopmentState({ stateRoot: root, snapshotRoot: dest });
  const manifestBytes = await readFile(join(dest, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const record = manifest.files.find(file => file.path === sessionRel);
  assert.ok(record);
  assert.equal(record.sha256, (await import('node:crypto')).createHash('sha256').update(sourceBytes).digest('hex'));
  assert.equal(record.sourceMode, sourceMode);
  assert.equal(record.destinationMode, 0o600);
  assert.equal(await readFile(join(dest, '.restored-session-files.json'), 'utf8'), restoredBindings);
  assert.ok(manifest.files.some(file => file.path === '.restored-session-files.json'));
  assert.equal((await lstat(join(dest, sessionRel))).mode & 0o777, 0o600);
  assert.equal((await lstat(sessionPath)).mode & 0o777, sourceMode);
  assert.equal(resultSnapshot.format, 'aylachi-offline-snapshot-v1');
  assert.equal(resultSnapshot.manifestSha256, (await import('node:crypto')).createHash('sha256').update(await readFile(join(dest, 'manifest.json'))).digest('hex'));
  assert.equal(manifest.files.some(f => f.path.startsWith('pi/history/')), false);
  assert.ok(manifest.files.some(f => f.path.startsWith('wiki/')));
  assert.deepEqual(await readFile(sessionPath), sourceBytes);
  const restored = join(parent, 'restored');
  const restoreResult = await restoreDevelopmentState({ snapshotRoot: dest, restoreRoot: restored, expectedManifestSha256: resultSnapshot.manifestSha256, sdk });
  assert.equal(restoreResult.files, resultSnapshot.files);
  assert.equal(await readFile(join(restored, 'core.sqlite')).then(() => true), true);
  assert.equal(await readFile(join(restored, 'handoff.sqlite')).then(() => true), true);
  assert.equal(await readFile(join(restored, 'wiki', manifest.files.find(f => f.path.startsWith('wiki/')).path.split('/')[1], 'CURRENT')).then(() => true), true);
  assert.equal(await readFile(join(restored, '.live-used')).then(() => true), true);
  await assert.rejects(readFile(join(restored, '.bearer')), { code: 'ENOENT' });
  assert.equal((await lstat(join(restored, '.aylachi-dev-root'))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(restored, 'pi', 'sessions', sessionId, sessionRel.split('/').at(-1)))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(restored, '.restored-session-files.json'), 'utf8'), JSON.stringify({ format: 1, sessions: { [sessionId]: sessionRel.split('/').at(-1) } }));
  const restoredApp = await startDevelopmentServer({ stateRoot: restored, port: 0 });
  try {
    assert.equal(restoredApp.modelStatus, 'disabled');
    const restoredCore = openStore(join(restored, 'core.sqlite'));
    try { assert.equal(restoredCore.getCard('card').title, 'synthetic'); }
    finally { restoredCore.close(); }
    const restoredHandoff = openHandoffStore(join(restored, 'handoff.sqlite'));
    restoredHandoff.close();
    const restoredWiki = await openWiki({ root: join(restored, 'wiki'), authorize: async () => true });
    assert.equal((await restoredWiki.search({ actor: 'test', query: 'synthetic wiki fixture' })).length, 1);
  } finally { assert.equal((await restoredApp.shutdown()).status, 'STOPPED'); }
  assert.notDeepEqual(await readFile(join(restored, '.bearer')), await readFile(join(root, '.bearer')), 'restored server must generate a new bearer');
  const manager = sdk.SessionManager.open(join(restored, sessionRel), join(restored, 'pi', 'sessions', sessionId), join(restored, 'workspace'));
  assert.equal(manager.getSessionId(), sessionRel.split('/').at(-1).slice(-42, -6));
  assert.equal(manager.getEntryCount() > 0, true);
  const contexts = [], baseRuntime = runtime();
  const continued = createPiAdapter({ sdk, model, modelRuntime: { ...baseRuntime, streamSimple(targetModel, context, options) { contexts.push(context); return baseRuntime.streamSimple(targetModel, context, options); } }, root: join(restored, 'pi'), cwd: join(restored, 'workspace'), restoredSessionFiles: JSON.parse(await readFile(join(restored, '.restored-session-files.json'), 'utf8')).sessions, toolDefinitions: [{ name: 'fixture_echo', label: 'Fixture echo', description: 'Synthetic', parameters: Type.Object({ text: Type.String() }), execute: async (_id, args) => ({ content: [{ type: 'text', text: args.text }] }) }] });
  try {
    await continued.prompt(sessionId, 'restored continuation');
    assert.ok(contexts.some(context => JSON.stringify(context.messages).includes('snapshot fixture prompt')));
  } finally { await continued.shutdown(); }
  assert.deepEqual(await readFile(join(dest, sessionRel)), sourceBytes);
  const invalidSessionTarget = join(parent, 'invalid-session-metadata');
  await assert.rejects(restoreDevelopmentState({ snapshotRoot: dest, restoreRoot: invalidSessionTarget,
    expectedManifestSha256: resultSnapshot.manifestSha256, sdk: { SessionManager: { open: () => ({ getHeader: () => null }) } } }), { code: 'SESSION_METADATA_INVALID' });
  await assert.rejects(lstat(join(invalidSessionTarget, '.aylachi-dev-root')), { code: 'ENOENT' });
  await assert.rejects(startDevelopmentServer({ stateRoot: invalidSessionTarget, port: 0 }), { code: 'UNOWNED_STATE_ROOT' });
  assert.deepEqual(await readFile(join(dest, sessionRel)), sourceBytes);
  const conflictingRoot = join(parent, 'publication-conflict');
  const markerText = 'aylachi-development-state-v1\n';
  await assert.rejects(restoreDevelopmentState({ snapshotRoot: dest, restoreRoot: conflictingRoot,
    expectedManifestSha256: resultSnapshot.manifestSha256, sdk: { SessionManager: { open(...args) {
      const manager = sdk.SessionManager.open(...args);
      writeFileSync(join(conflictingRoot, '.aylachi-dev-root'), markerText, { mode: 0o600, flag: 'wx' });
      return manager;
    } } } }), { code: 'RESTORE_ROOT_CHANGED' });
  assert.equal(await readFile(join(conflictingRoot, '.aylachi-dev-root'), 'utf8'), markerText, 'conflicting marker must not be deleted');
  assert.equal(await readFile(join(conflictingRoot, '.restore-pending'), 'utf8'), markerText);
  await assert.rejects(startDevelopmentServer({ stateRoot: conflictingRoot, port: 0 }), { code: 'UNOWNED_STATE_ROOT' });
  assert.deepEqual(await readFile(join(dest, sessionRel)), sourceBytes);
  await assert.rejects(restoreDevelopmentState({ snapshotRoot: dest, restoreRoot: restored, expectedManifestSha256: resultSnapshot.manifestSha256, sdk }), { code: 'DESTINATION_EXISTS' });
  await assert.rejects(restoreDevelopmentState({ snapshotRoot: dest, restoreRoot: join(parent, 'restore-untrusted'), sdk }), { code: 'UNTRUSTED_MANIFEST_HASH' });
  for (const file of manifest.files) {
    const expected = (await import('node:crypto')).createHash('sha256').update(await readFile(join(dest, file.path))).digest('hex');
    assert.equal(expected, file.sha256);
    assert.equal((await import('node:crypto')).createHash('sha256').update(await readFile(join(root, file.path))).digest('hex'), file.sha256);
  }
  const tampered = { ...manifest, files: manifest.files.map((file, index) => index ? file : { ...file, path: '../escape' }) };
  const tamperedBytes = Buffer.from(JSON.stringify(tampered));
  await writeFile(join(dest, 'manifest.json'), tamperedBytes, { mode: 0o600 });
  const tamperedHash = (await import('node:crypto')).createHash('sha256').update(tamperedBytes).digest('hex');
  const badTarget = join(parent, 'restore-tampered');
  await assert.rejects(restoreDevelopmentState({ snapshotRoot: dest, restoreRoot: badTarget, expectedManifestSha256: tamperedHash, sdk }), { code: 'INVALID_MANIFEST' });
  await assert.rejects(lstat(badTarget), { code: 'ENOENT' });
  await writeFile(join(dest, 'manifest.json'), manifestBytes, { mode: 0o600 });
  assert.deepEqual(await readFile(sessionPath), sourceBytes);
  await chmod(sessionPath, 0o666);
  try {
    await assert.rejects(snapshotDevelopmentState({ stateRoot: root, snapshotRoot: join(parent, 'world-write') }), { code: 'UNSAFE_FILE' });
  } finally { await chmod(sessionPath, sourceMode); }
  const sessionDirectory = join(root, 'pi', 'sessions', sessionId);
  await chmod(sessionDirectory, 0o755);
  try {
    await assert.rejects(snapshotDevelopmentState({ stateRoot: root, snapshotRoot: join(parent, 'public-directory') }), { code: 'UNSAFE_TREE_ENTRY' });
  } finally { await chmod(sessionDirectory, 0o700); }
});

test('restore rejects malformed manifests and preserves an unmarked failed database restore', async t => {
  const { parent, root } = await fixture(t), snapshotRoot = join(parent, 'snapshot');
  const sourceCore = await readFile(join(root, 'core.sqlite'));
  await writeFile(join(root, '.restored-session-files.json'), JSON.stringify({ format: 1, sessions: {} }), { mode: 0o600 });
  const snapshot = await snapshotDevelopmentState({ stateRoot: root, snapshotRoot });
  const manifestPath = join(snapshotRoot, 'manifest.json');
  const originalManifestBytes = await readFile(manifestPath);
  const emptyBindingRoot = join(parent, 'empty-binding-restore');
  await restoreDevelopmentState({ snapshotRoot, restoreRoot: emptyBindingRoot, expectedManifestSha256: snapshot.manifestSha256 });
  const emptyBindingApp = await startDevelopmentServer({ stateRoot: emptyBindingRoot, port: 0 });
  try { assert.equal(emptyBindingApp.modelStatus, 'disabled'); }
  finally { assert.equal((await emptyBindingApp.shutdown()).status, 'STOPPED'); }
  const hash = bytes => import('node:crypto').then(({ createHash }) => createHash('sha256').update(bytes).digest('hex'));
  const untrusted = join(parent, 'bad-hash');
  await assert.rejects(restoreDevelopmentState({ snapshotRoot, restoreRoot: untrusted, expectedManifestSha256: '0'.repeat(64) }), { code: 'MANIFEST_HASH_MISMATCH' });
  await assert.rejects(lstat(untrusted), { code: 'ENOENT' });
  const nullSchema = Buffer.from(JSON.stringify({ ...JSON.parse(originalManifestBytes), schema: null }));
  await writeFile(manifestPath, nullSchema);
  const nullTarget = join(parent, 'null-schema');
  await assert.rejects(restoreDevelopmentState({ snapshotRoot, restoreRoot: nullTarget, expectedManifestSha256: await hash(nullSchema) }), { code: 'INVALID_MANIFEST' });
  await assert.rejects(lstat(nullTarget), { code: 'ENOENT' });
  await truncate(manifestPath, 16 * 1024 * 1024 + 1);
  await assert.rejects(restoreDevelopmentState({ snapshotRoot, restoreRoot: join(parent, 'oversized'), expectedManifestSha256: snapshot.manifestSha256 }), { code: 'SNAPSHOT_LIMIT' });
  const invalidCore = Buffer.from('not a SQLite database\n');
  await writeFile(join(snapshotRoot, 'core.sqlite'), invalidCore);
  const manifest = JSON.parse(originalManifestBytes);
  const coreRecord = manifest.files.find(file => file.path === 'core.sqlite');
  coreRecord.size = invalidCore.length; coreRecord.sha256 = await hash(invalidCore);
  const modifiedManifest = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, modifiedManifest);
  const failedRoot = join(parent, 'failed-restore');
  await assert.rejects(restoreDevelopmentState({ snapshotRoot, restoreRoot: failedRoot, expectedManifestSha256: await hash(modifiedManifest) }), error => /SQLITE/i.test(error.code));
  assert.equal((await lstat(failedRoot)).isDirectory(), true);
  await assert.rejects(lstat(join(failedRoot, '.aylachi-dev-root')), { code: 'ENOENT' });
  await assert.rejects(startDevelopmentServer({ stateRoot: failedRoot, port: 0 }), { code: 'UNOWNED_STATE_ROOT' });
  assert.deepEqual(await readFile(join(root, 'core.sqlite')), sourceCore);
  assert.deepEqual(await readFile(join(snapshotRoot, 'core.sqlite')), invalidCore);
  assert.deepEqual(await readFile(manifestPath), modifiedManifest);
  await rm(join(snapshotRoot, 'core.sqlite'));
  const wrongSchemaDb = new DatabaseSync(join(snapshotRoot, 'core.sqlite'));
  try { wrongSchemaDb.exec('CREATE TABLE unrelated(id TEXT PRIMARY KEY)'); }
  finally { wrongSchemaDb.close(); }
  await chmod(join(snapshotRoot, 'core.sqlite'), 0o600);
  const wrongSchemaBytes = await readFile(join(snapshotRoot, 'core.sqlite'));
  coreRecord.size = wrongSchemaBytes.length; coreRecord.sha256 = await hash(wrongSchemaBytes);
  const wrongSchemaManifest = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, wrongSchemaManifest);
  const wrongSchemaRoot = join(parent, 'unsupported-database');
  await assert.rejects(restoreDevelopmentState({ snapshotRoot, restoreRoot: wrongSchemaRoot, expectedManifestSha256: await hash(wrongSchemaManifest) }), { code: 'UNSUPPORTED_DATABASE_SCHEMA' });
  await assert.rejects(lstat(join(wrongSchemaRoot, '.aylachi-dev-root')), { code: 'ENOENT' });
  await assert.rejects(startDevelopmentServer({ stateRoot: wrongSchemaRoot, port: 0 }), { code: 'UNOWNED_STATE_ROOT' });
  assert.deepEqual(await readFile(join(root, 'core.sqlite')), sourceCore);
  assert.deepEqual(await readFile(join(snapshotRoot, 'core.sqlite')), wrongSchemaBytes);
});

test('running source denied; WAL and existing destination fail with exact codes', async t => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-l05-live-')); await chmod(parent, 0o700); t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'state'), app = await startDevelopmentServer({ stateRoot: root, port: 0 });
  await assert.rejects(snapshotDevelopmentState({ stateRoot: root, snapshotRoot: join(parent, 'running') }), { code: 'STATE_LOCKED' });
  await app.shutdown();
  await writeFile(join(root, 'core.sqlite-wal'), 'x', { mode: 0o600 });
  await assert.rejects(snapshotDevelopmentState({ stateRoot: root, snapshotRoot: join(parent, 'wal') }), { code: 'SQLITE_SIDECAR_PRESENT' });
  await rm(join(root, 'core.sqlite-wal'));
  await mkdir(join(parent, 'exists'), { mode: 0o700 });
  await assert.rejects(snapshotDevelopmentState({ stateRoot: root, snapshotRoot: join(parent, 'exists') }), { code: 'DESTINATION_EXISTS' });
});

test('snapshots and restores durable tool effects with their exact schema', async t => {
  const { parent, root } = await fixture(t);
  await writeFile(join(root, 'tool-effects.sqlite'), '', { mode: 0o600, flag: 'wx' });
  const effects = openToolEffectStore(join(root, 'tool-effects.sqlite'));
  effects.reserve({ actor: 'aylachi-dev-owner', requestId: 'effect-request', parentCommandId: 'parent-command',
    parentCardId: 'card', canvasId: 'fixture', toolName: 'delegate_task', text: 'synthetic effect', requiresApproval: true, now: 1 });
  effects.close();
  const snapshotRoot = join(parent, 'snapshot-effects');
  const snapshot = await snapshotDevelopmentState({ stateRoot: root, snapshotRoot });
  const manifest = JSON.parse(await readFile(join(snapshotRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema.effects, 'delegation/effects.mjs');
  assert.ok(manifest.files.some(file => file.path === 'tool-effects.sqlite'));
  const restoreRoot = join(parent, 'restored-effects');
  await restoreDevelopmentState({ snapshotRoot, restoreRoot, expectedManifestSha256: snapshot.manifestSha256 });
  const restored = openToolEffectStore(join(restoreRoot, 'tool-effects.sqlite'));
  try {
    const record = restored.findRequest({ actor: 'aylachi-dev-owner', requestId: 'effect-request' });
    assert.equal(record.state, 'PENDING_APPROVAL');
    assert.equal(record.text, 'synthetic effect');
  } finally { restored.close(); }
});

test('snapshots and restores artifact versions and exact source snapshots', async t => {
  const { parent, root } = await fixture(t);
  const store = openArtifactStore(join(root, 'artifacts.sqlite'));
  createArtifactEngine({ store }).create({ artifactId: 'snapshot-artifact', idempotencyKey: 'snapshot-request',
    title: 'Snapshot', format: 'markdown', content: '# Durable\n', origin: { kind: 'api' },
    sources: [{ uri: 'https://example.com/source', snapshot: 'exact evidence\n' }] });
  store.close();
  const snapshotRoot = join(parent, 'snapshot-artifacts');
  const snapshot = await snapshotDevelopmentState({ stateRoot: root, snapshotRoot });
  const manifest = JSON.parse(await readFile(join(snapshotRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema.artifacts, 'artifact-engine/store.mjs');
  assert.ok(manifest.files.some(file => file.path === 'artifacts.sqlite'));
  const restoreRoot = join(parent, 'restored-artifacts');
  await restoreDevelopmentState({ snapshotRoot, restoreRoot, expectedManifestSha256: snapshot.manifestSha256 });
  const restoredStore = openArtifactStore(join(restoreRoot, 'artifacts.sqlite'));
  try {
    const restored = createArtifactEngine({ store: restoredStore }).get('snapshot-artifact');
    assert.equal(restored.version.content, '# Durable\n');
    assert.equal(restored.version.sources[0].snapshot, 'exact evidence\n');
  } finally { restoredStore.close(); }
});

test('snapshots and restores durable backend conversation bindings', async t => {
  const { parent, root } = await fixture(t);
  const store = openBackendStore(join(root, 'backends.sqlite'));
  store.bind({ cardId: 'card', backendId: 'pi', backendRevision: 1, sessionId: 'session' });
  store.close();
  const snapshotRoot = join(parent, 'snapshot-backends');
  const snapshot = await snapshotDevelopmentState({ stateRoot: root, snapshotRoot });
  const manifest = JSON.parse(await readFile(join(snapshotRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema.backends, 'backends/store.mjs');
  assert.ok(manifest.files.some(file => file.path === 'backends.sqlite'));
  const restoreRoot = join(parent, 'restored-backends');
  await restoreDevelopmentState({ snapshotRoot, restoreRoot, expectedManifestSha256: snapshot.manifestSha256 });
  const restored = openBackendStore(join(restoreRoot, 'backends.sqlite'));
  try { assert.deepEqual(restored.get('card'), { cardId: 'card', backendId: 'pi', backendRevision: 1, sessionId: 'session', createdAt: restored.get('card').createdAt }); }
  finally { restored.close(); }
});

test('snapshots and restores channel delivery state and memory promotion state', async t => {
  const { parent, root } = await fixture(t);
  const channels = openChannelStore(join(root, 'channels.sqlite'));
  const { route } = channels.bind({ channel: 'telegram', accountId: 'account', chatId: 'chat', threadId: 'thread', conversationId: 'card' });
  const { message } = channels.receive(route.id, { externalMessageId: 'external', actingPrincipal: 'user', text: 'hello' });
  channels.completeInbound(message.id, { commandId: 'channel-command', handoff: { source: { conversationId: 'card', commandId: 'channel-command' } }, responseText: 'reply' });
  channels.close();
  const memory = openMemoryStore(join(root, 'memory.sqlite'));
  const proposal = memory.propose({ owner: 'author', requestId: 'proposal', targetId: 'target', baseRevision: 1,
    content: '# proposed', worktree: '/srv/aylachi/coding-repos/memory-review', branch: 'review/memory' }).proposal;
  memory.review(proposal.id, { expectedRevision: 1, reviewer: 'reviewer', decision: 'APPROVED' });
  memory.close();
  const snapshotRoot = join(parent, 'snapshot-m6');
  const snapshot = await snapshotDevelopmentState({ stateRoot: root, snapshotRoot });
  const manifest = JSON.parse(await readFile(join(snapshotRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema.channels, 'channels/store.mjs');
  assert.equal(manifest.schema.memory, 'memory/store.mjs');
  const restoreRoot = join(parent, 'restored-m6');
  await restoreDevelopmentState({ snapshotRoot, restoreRoot, expectedManifestSha256: snapshot.manifestSha256 });
  const restoredChannels = openChannelStore(join(restoreRoot, 'channels.sqlite'));
  const restoredMemory = openMemoryStore(join(restoreRoot, 'memory.sqlite'));
  try {
    assert.equal(restoredChannels.inbox(message.id).actingPrincipal, 'user');
    assert.equal(restoredChannels.outbound()[0].state, 'PENDING');
    assert.equal(restoredMemory.get(proposal.id).state, 'APPROVED');
  } finally { restoredChannels.close(); restoredMemory.close(); }
});

test('unsafe source file hardlink and symlink are rejected specifically', async t => {
  const { parent, root } = await fixture(t);
  await link(join(root, 'core.sqlite'), join(parent, 'hardlink'));
  await assert.rejects(snapshotDevelopmentState({ stateRoot: root, snapshotRoot: join(parent, 'snap-hardlink') }), { code: 'UNSAFE_FILE' });
  await rm(join(parent, 'hardlink'));
  await symlink(join(parent, 'outside'), join(root, 'pi', 'bad.jsonl'));
  await assert.rejects(snapshotDevelopmentState({ stateRoot: root, snapshotRoot: join(parent, 'snap-link') }), { code: 'UNSAFE_TREE_ENTRY' });
});
