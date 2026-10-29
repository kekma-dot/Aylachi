import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDevelopmentServer } from './server.mjs';
import { createHubClient } from '../desktop-ui/hub-client.mjs';
import { createSourceController } from '../desktop-ui/source-controller.mjs';

async function fixture(content = 'export const value = 1;\n') {
  const root = await mkdtemp(join(tmpdir(), 'source-app-'));
  const labRoot = join(root, 'lab');
  await mkdir(join(labRoot, 'checkout'), { recursive: true, mode: 0o700 });
  await writeFile(join(labRoot, '.aylachi-source-lab'), 'aylachi-source-workbench-v1\n', { mode: 0o600 });
  await writeFile(join(labRoot, 'checkout', 'sample.mjs'), content, { mode: 0o600 });
  return { root, labRoot, stateRoot: join(root, 'app'), files: [{ id: 'sample', path: 'sample.mjs' }] };
}
async function connect(server, stateRoot) {
  const token = (await readFile(join(stateRoot, '.bearer'), 'utf8')).trim();
  const call = async (method, path, body, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { method,
      headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  call.hubClient = createHubClient({ baseUrl: `http://127.0.0.1:${server.address.port}`, bearer: token });
  return call;
}

if (process.platform === 'linux') test('assembled source HTTP: auth, CAS, budgets, restart nonce and disabled startup', async () => {
  const f = await fixture(), config = { stateRoot: f.stateRoot, port: 0, sourceWorkbench: { labRoot: f.labRoot, files: f.files } };
  let server = await startDevelopmentServer(config);
  try {
    let call = await connect(server, f.stateRoot);
    const base = '/v1/modules/source-workbench/files';
    assert.equal((await call('GET', base, undefined, false)).status, 401);
    const listed = await call('GET', base); assert.equal(listed.status, 200); assert.equal(listed.body.files.length, 1);
    const caps = await call('GET', '/v1/modules/workspace/capabilities');
    assert.equal(caps.body.version, 2); assert.equal(caps.body.modules.sourceWorkbench, true);
    const original = (await call('GET', `${base}/sample`)).body;
    const content = 'export const value = 2;\n';
    const update = { content, expectedSha256: original.sha256, instanceId: original.instanceId };
    assert.equal((await call('POST', `${base}/sample`, { ...update, path: '/outside' })).status, 400);
    assert.equal((await call('POST', `${base}/sample`, { ...update, instanceId: 'stale' })).status, 409);
    // Body fits the transport, but its next GET would exceed the response cap. No mutation allowed.
    let oversized = '\\'.repeat(32700);
    while (Buffer.byteLength(JSON.stringify({ ...update, content: oversized })) > 65536) oversized = oversized.slice(1);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...original, content: oversized })) > 65536);
    assert.equal((await call('POST', `${base}/sample`, { ...update, content: oversized })).status, 413);
    assert.equal((await call('GET', `${base}/sample`)).body.sha256, original.sha256);
    assert.equal((await call('POST', `${base}/sample`, update)).status, 200);
    assert.equal((await call('POST', `${base}/sample`, update)).status, 409);
    const saved = (await call('GET', `${base}/sample`)).body;
    assert.equal(saved.content, content); assert.equal(saved.baselineSha256, original.sha256);
    assert.equal((await call('GET', `${base}/sample/diff?offset=0&sha256=${saved.sha256}&instanceId=${saved.instanceId}`)).body.toSha256, saved.sha256);
    const controller = createSourceController({ hubClient: call.hubClient });
    assert.equal(await controller.refresh(), true); assert.equal(await controller.selectFile('sample'), true);
    const finalContent = 'export const value = 3;\n';
    controller.edit(finalContent); assert.equal(await controller.save(), true);
    assert.equal(await controller.loadDiff(), true); assert.equal(controller.getSnapshot().dirty, false);
    controller.dispose();
    await server.shutdown();
    server = await startDevelopmentServer(config); call = await connect(server, f.stateRoot);
    assert.notEqual((await call('GET', base)).body.instanceId, original.instanceId);
    assert.equal((await call('POST', `${base}/sample`, { ...update, expectedSha256: saved.sha256 })).status, 409);
    await server.shutdown();
    server = await startDevelopmentServer({ stateRoot: f.stateRoot, port: 0 }); call = await connect(server, f.stateRoot);
    assert.equal((await call('GET', base)).status, 404);
    assert.deepEqual((await call('GET', '/v1/modules/workspace/capabilities')).body,
      { version: 1, modules: { wiki: true, handoff: true, artifactEngine: true, backends: true, pluginPlane: true, channels: true, memory: true, browser: true, themes: true } });
    assert.equal(await readFile(join(f.labRoot, 'checkout', 'sample.mjs'), 'utf8'), finalContent);
  } finally { await server.shutdown(); }
});

if (process.platform === 'linux') test('full 32KiB rewrite diff survives bounded HTTP pagination without truncation', async () => {
  const before = 'a'.repeat(32768), after = 'b'.repeat(32768), f = await fixture(before);
  const server = await startDevelopmentServer({ stateRoot: f.stateRoot, port: 0, sourceWorkbench: { labRoot: f.labRoot, files: f.files } });
  try {
    const call = await connect(server, f.stateRoot), controller = createSourceController({ hubClient: call.hubClient });
    assert.equal(await controller.refresh(), true); assert.equal(await controller.selectFile('sample'), true);
    controller.edit(after); assert.equal(await controller.save(), true); assert.equal(await controller.loadDiff(), true);
    const diff = controller.getSnapshot().diff;
    assert.equal(diff.changes.length, 1); assert.deepEqual(diff.changes[0].remove, [before]); assert.deepEqual(diff.changes[0].insert, [after]);
    const selected = controller.getSnapshot().selected;
    const first = await call('GET', `/v1/modules/source-workbench/files/sample/diff?offset=0&sha256=${selected.sha256}&instanceId=${selected.instanceId}`);
    assert.ok(first.body.nextOffset > 0); assert.ok(Buffer.byteLength(JSON.stringify(first.body)) < 65536);
    const changed = await call('POST', '/v1/modules/source-workbench/files/sample', { content: 'changed', expectedSha256: selected.sha256, instanceId: selected.instanceId });
    assert.equal(changed.status, 200);
    assert.equal((await call('GET', `/v1/modules/source-workbench/files/sample/diff?offset=${first.body.nextOffset}&sha256=${selected.sha256}&instanceId=${selected.instanceId}`)).status, 409);
    controller.dispose();
  } finally { await server.shutdown(); }
});

test('malformed source config fails before getters or application state creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-invalid-')), stateRoot = join(root, 'app');
  let getters = 0;
  const sourceWorkbench = { files: [] };
  Object.defineProperty(sourceWorkbench, 'labRoot', { enumerable: true, get() { getters++; throw Error('getter'); } });
  await assert.rejects(startDevelopmentServer({ stateRoot, port: 0, sourceWorkbench }), { code: 'SOURCE_OPTIONS_INVALID' });
  assert.equal(getters, 0); await assert.rejects(stat(stateRoot), { code: 'ENOENT' });
  await assert.rejects(startDevelopmentServer({ stateRoot, sourceWorkbench: { labRoot: '/srv/aylachi/baza', files: [{ id: 'x', path: 'x.mjs' }] } }), { code: 'SOURCE_OPTIONS_INVALID' });
  await assert.rejects(stat(stateRoot), { code: 'ENOENT' });
});
