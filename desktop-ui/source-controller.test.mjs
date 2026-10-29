import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceController } from './source-controller.mjs';
const initial = { id: 'sample', path: 'sample.mjs', content: 'old', sha256: 'a'.repeat(64), baselineSha256: 'a'.repeat(64), instanceId: 'c'.repeat(32) };
function fixture() {
  let current = { ...initial }, mode = 'ok', posts = 0;
  const controller = createSourceController({ hubClient: { async moduleRequest({ method, path, body }) {
    if (method === 'POST') {
      posts++;
      if (mode === 'unknown') throw Object.assign(new Error(), { unknownOutcome: true });
      if (mode === 'conflict') throw Object.assign(new Error(), { status: 409 });
      assert.equal(body.instanceId, current.instanceId); assert.equal(body.expectedSha256, current.sha256);
      current = { ...current, content: body.content, sha256: 'b'.repeat(64) };
      return { id: current.id, sha256: current.sha256, baselineSha256: current.baselineSha256, instanceId: current.instanceId };
    }
    if (path.endsWith('/files')) {
      const { content, instanceId, ...row } = current;
      return { files: [row], instanceId };
    }
    if (path.includes('/diff?')) return { id: current.id, fromSha256: initial.sha256, toSha256: current.sha256, chunk: '[]', offset: 0, nextOffset: null, total: 2, instanceId: current.instanceId };
    return { ...current };
  } } });
  return { controller, mode: value => { mode = value; }, replace: value => { current = { ...current, ...value }; }, posts: () => posts };
}
async function select(c) { assert.equal(await c.refresh(), true); assert.equal(await c.selectFile('sample'), true); }

test('source controller edits/saves with hashes, retains draft across blocked switching and loads saved diff', async () => {
  const { controller: c, posts } = fixture(); await select(c);
  c.edit('new'); assert.equal(c.getSnapshot().dirty, true);
  assert.equal(await c.selectFile('sample'), false); assert.equal(c.getSnapshot().draft, 'new');
  assert.equal(await c.save(), true); assert.equal(posts(), 1);
  assert.equal(c.getSnapshot().selected.sha256, 'b'.repeat(64)); assert.equal(c.getSnapshot().dirty, false);
  assert.equal(await c.loadDiff(), true); c.dispose();
});
test('unknown POST stays locked after authoritative read; no automatic replay or draft loss', async () => {
  const f = fixture(), c = f.controller; await select(c); c.edit('keep'); f.mode('unknown');
  assert.equal(await c.save(), false); assert.equal(c.getSnapshot().uncertain, true);
  assert.equal(await c.reconcile(), true); assert.equal(c.getSnapshot().draft, 'keep');
  assert.equal(c.getSnapshot().uncertain, true); assert.equal(await c.save(), false); assert.equal(f.posts(), 1); c.dispose();
});
test('explicit conflict reconciliation updates basis while retaining draft; malformed replies fail closed', async () => {
  const f = fixture(), c = f.controller; await select(c); c.edit('draft'); f.mode('conflict');
  await c.save(); assert.equal(c.getSnapshot().conflict, true);
  f.replace({ content: 'other', sha256: 'd'.repeat(64) });
  await c.reconcile(); assert.equal(c.getSnapshot().draft, 'draft'); assert.equal(c.getSnapshot().conflict, false);
  c.discardDraft(); assert.equal(c.getSnapshot().draft, 'other'); c.dispose();
  const bad = createSourceController({ hubClient: { moduleRequest: async () => ({ files: [{ ...initial }], instanceId: initial.instanceId }) } });
  assert.equal(await bad.refresh(), false); assert.deepEqual(bad.getSnapshot().files, []); bad.dispose();
});
