import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import test from 'node:test';
import { createHubClient } from '../hub/client.mjs';
import { startDevelopmentServer } from '../runtime/server.mjs';

const bearer = async root => (await readFile(join(root, '.bearer'), 'utf8')).trim();

test('M7 Hub composes Browser Graph runs and review-gated declarative themes across restart', async t => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-m7-'));
  await chmod(parent, 0o700);
  const stateRoot = join(parent, 'state');
  t.after(() => rm(parent, { recursive: true, force: true }));
  let remoteCalls = 0, localCalls = 0;
  const browserAdapters = {
    remoteReadOnly: { id: 'remote-read-only', health: () => ({ state: 'READY' }), navigate: async ({ url }) => {
      remoteCalls++;
      return { url, title: 'Synthetic remote', text: 'Remote snapshot', links: [] };
    } },
    localInteractive: { id: 'local-interactive', health: () => ({ state: 'READY' }), snapshot: async () => {
      localCalls++;
      return { url: 'https://local.example/', title: 'Synthetic local', text: 'Local snapshot', links: [] };
    } },
  };
  let app = await startDevelopmentServer({ stateRoot, port: 0, browserAdapters });
  let client = createHubClient({ baseUrl: `http://127.0.0.1:${app.address.port}`, bearer: await bearer(stateRoot) });
  const call = (method, path, body) => client.moduleRequest({ method, path, body });
  try {
    const capabilities = await call('GET', '/v1/modules/workspace/capabilities');
    assert.equal(capabilities.modules.browser, true);
    assert.equal(capabilities.modules.themes, true);
    const remote = await call('POST', '/v1/modules/workspace/graph/nodes', { kind: 'browser', title: 'Remote', x: 0, y: 0,
      mode: 'remote-read-only', allowedHosts: ['example.com'] });
    assert.equal(remote.node.kind, 'browser');
    const navigation = { expectedRevision: 1, url: 'https://example.com/docs', idempotencyKey: 'remote-navigate' };
    const navigated = await call('POST', `/v1/modules/browser/sessions/${remote.session.id}/navigation`, navigation);
    assert.equal(navigated.snapshot.text, 'Remote snapshot');
    assert.equal(remoteCalls, 1);
    assert.equal((await call('POST', `/v1/modules/browser/sessions/${remote.session.id}/navigation`, navigation)).idempotent, true);
    assert.equal(remoteCalls, 1);
    let graph = await call('GET', '/v1/modules/workspace/graph');
    const browserRun = graph.runs.find(run => run.rootNodeId === remote.node.id);
    assert.equal(browserRun.status, 'SUCCEEDED');
    assert.equal(graph.artifacts.find(artifact => artifact.runId === browserRun.id).kind, 'browser-snapshot');

    const local = await call('POST', '/v1/modules/workspace/graph/nodes', { kind: 'browser', title: 'Local', x: 600, y: 0,
      mode: 'local-interactive', allowedHosts: [] });
    await assert.rejects(call('POST', `/v1/modules/browser/sessions/${local.session.id}/navigation`, { expectedRevision: 1,
      url: 'https://local.example/', idempotencyKey: 'local-denied' }), error => error.status === 409);
    assert.equal(localCalls, 0);
    const localSnapshot = await call('POST', `/v1/modules/browser/sessions/${local.session.id}/snapshots`, { expectedRevision: 1, idempotencyKey: 'local-refresh' });
    assert.equal(localSnapshot.snapshot.text, 'Local snapshot');
    assert.equal(localCalls, 1);

    await call('POST', '/v1/modules/workspace/graph/nodes', { kind: 'theme', title: 'Theme Editor', x: 1200, y: 0 });
    const saved = await call('POST', '/v1/modules/themes', { name: 'Calm', base: 'light', tokens: { radius: 4 },
      expectedWorkspaceRevision: 1, idempotencyKey: 'theme-create' });
    assert.equal(saved.workspace.active.version.tokens.radius, 4);
    const appended = await call('POST', `/v1/modules/themes/${saved.theme.id}/versions`, { base: 'light', tokens: { radius: 8 },
      expectedVersion: 1, expectedWorkspaceRevision: 2, idempotencyKey: 'theme-append' });
    assert.equal(appended.version.tokens.radius, 8);
    const rolledBack = await call('POST', `/v1/modules/themes/${saved.theme.id}/rollback`, { targetVersion: 1,
      expectedVersion: 2, expectedWorkspaceRevision: 3, idempotencyKey: 'theme-rollback' });
    assert.equal(rolledBack.version.version, 3);
    assert.equal(rolledBack.version.tokens.radius, 4);
    const proposal = await call('POST', '/v1/modules/themes/proposals', { name: 'Agent dark', base: 'dark', tokens: {},
      idempotencyKey: 'agent-theme', origin: { kind: 'pi', sessionId: 'session', turnId: 'turn', toolCallId: 'call' } });
    assert.equal(proposal.theme.state, 'PROPOSED');
    assert.equal(proposal.workspace.active.theme.id, saved.theme.id);
    assert.equal(proposal.workspace.revision, 4);
    const activated = await call('POST', `/v1/modules/themes/${proposal.theme.id}/activate`, { expectedVersion: 1,
      expectedWorkspaceRevision: 4, idempotencyKey: 'agent-accept' });
    assert.equal(activated.workspace.active.version.tokens.base, 'dark');
    const disabled = await call('POST', '/v1/modules/themes/disable', { expectedWorkspaceRevision: 5, idempotencyKey: 'theme-disable' });
    assert.equal(disabled.workspace.active, null);
    graph = await call('GET', '/v1/modules/workspace/graph');
    assert.equal(graph.nodes.some(node => node.kind === 'theme'), true);
    await assert.rejects(call('POST', '/v1/modules/workspace/graph/runs', { scope: 'all' }), error => error.status === 400);
  } finally { await app.shutdown(); }

  app = await startDevelopmentServer({ stateRoot, port: 0, browserAdapters });
  client = createHubClient({ baseUrl: `http://127.0.0.1:${app.address.port}`, bearer: await bearer(stateRoot) });
  try {
    const restored = await client.moduleRequest({ method: 'GET', path: '/v1/modules/workspace/graph' });
    assert.equal(restored.nodes.filter(node => node.kind === 'browser').length, 2);
    assert.equal(restored.artifacts.some(artifact => artifact.kind === 'browser-snapshot'), true);
    const themes = await client.moduleRequest({ method: 'GET', path: '/v1/modules/themes' });
    assert.equal(themes.active, null);
    assert.equal(themes.themes.length, 2);
  } finally { await app.shutdown(); }
});
