import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArtifactEngine } from './engine.mjs';
import { htmlPreviewDocument } from './renderers.mjs';
import { openArtifactStore } from './store.mjs';

const origin = { kind: 'pi', sessionId: 'session', turnId: 'turn', toolCallId: 'call' };
const input = (key = 'request-1') => ({ artifactId: 'artifact-one', idempotencyKey: key, title: 'Launch plan', format: 'markdown',
  content: '# Launch\n', sources: [{ uri: 'https://example.com/spec', label: 'Spec', snapshot: 'exact source\n' }], origin });

test('artifact engine persists versions/source snapshots, deduplicates retry and exports exact content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'artifacts.sqlite');
  let store = openArtifactStore(path, { now: () => 100 });
  let engine = createArtifactEngine({ store });
  const created = engine.create(input());
  assert.equal(created.version.version, 1);
  assert.equal(created.idempotent, undefined);
  const replay = engine.create(input());
  assert.equal(replay.idempotent, true);
  assert.equal(engine.list().length, 1);
  assert.throws(() => engine.create({ ...input(), content: '# Changed\n' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const updated = engine.update({ ...input('request-2'), artifactId: 'artifact-one', expectedVersion: 1, title: 'Launch v2', content: '# Two\n' });
  assert.equal(updated.version.version, 2);
  assert.throws(() => engine.update({ ...input('request-3'), artifactId: 'artifact-one', expectedVersion: 1 }), { code: 'VERSION_CONFLICT' });
  const rolledBack = engine.rollback({ artifactId: 'artifact-one', targetVersion: 1, idempotencyKey: 'request-4', origin });
  assert.equal(rolledBack.version.version, 3);
  assert.equal(rolledBack.version.content, '# Launch\n');
  assert.equal(engine.versions('artifact-one').length, 3);
  store.close();
  store = openArtifactStore(path, { now: () => 200 });
  engine = createArtifactEngine({ store });
  const restored = engine.export('artifact-one', 1);
  assert.equal(restored.fileName, 'launch-plan.md');
  assert.equal(restored.content, '# Launch\n');
  assert.equal(restored.manifest.sources[0].snapshot, 'exact source\n');
  assert.match(restored.manifest.sources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(restored.contentHash, engine.export('artifact-one', 1).contentHash);
  store.close();
});

test('renderers are replaceable and HTML preview has a restrictive first CSP', () => {
  const preview = htmlPreviewDocument('<html><script>fetch("https://evil")</script></html>');
  assert.ok(preview.indexOf("default-src 'none'") < preview.indexOf('<html>'));
  assert.match(preview, /img-src data:/);
  assert.doesNotMatch(preview, /allow-scripts/);
  const store = { get: () => ({ artifact: { id: 'a' }, version: { title: 'X', format: 'custom', content: 'ok', contentHash: 'h', sources: [], version: 1 } }),
    list() {}, versions() {}, create() {}, append() {}, rollback() {} };
  const engine = createArtifactEngine({ store, renderers: { custom: { validate() {}, export: ({ content }) => ({ fileName: 'x.txt', mimeType: 'text/plain', content }) } } });
  assert.equal(engine.export('a').content, 'ok');
});
