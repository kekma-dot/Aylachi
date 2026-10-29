import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultThemeTokens, snapshotThemeTokens, themeCssVariables } from './schema.mjs';
import { openThemeStore } from './store.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aylachi-themes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, 'themes.sqlite') };
}

test('declarative theme schema rejects executable or arbitrary CSS input', () => {
  const tokens = defaultThemeTokens('dark');
  tokens.colors.accent = '#A1B2C3';
  assert.deepEqual(snapshotThemeTokens(tokens).colors.accent, '#a1b2c3');
  assert.equal(themeCssVariables(tokens)['--font-size'], '14px');
  for (const value of [
    { colors: { accent: 'url(https://example.com)' } }, { radius: 100 }, { density: 'dense' },
    { typography: { family: 'system; background:url(x)' } }, { script: 'alert(1)' }, { shadow: { opacity: 1 } },
  ]) assert.throws(() => snapshotThemeTokens(value), error => error.code === 'INVALID_THEME_TOKENS');
});

test('user themes save, retry, disable and rollback with workspace CAS and durable versions', async t => {
  const { path } = await fixture(t);
  let store = openThemeStore(path);
  const initial = store.workspace('fixture');
  const created = store.create({ id: 'calm', canvasId: 'fixture', origin: 'user', name: 'Calm', base: 'light', tokens: { radius: 4 },
    expectedWorkspaceRevision: initial.revision, idempotencyKey: 'create-calm' });
  assert.equal(created.workspace.active.theme.id, 'calm');
  assert.equal(created.version.version, 1);
  assert.equal(created.workspace.revision, 2);
  assert.equal(store.create({ id: 'calm', canvasId: 'fixture', origin: 'user', name: 'Calm', base: 'light', tokens: { radius: 4 },
    expectedWorkspaceRevision: 1, idempotencyKey: 'create-calm' }).idempotent, true);
  assert.throws(() => store.create({ id: 'other', canvasId: 'fixture', origin: 'user', name: 'Other', tokens: {},
    expectedWorkspaceRevision: 1, idempotencyKey: 'stale' }), error => error.code === 'REVISION_CONFLICT');
  const appended = store.append({ themeId: 'calm', canvasId: 'fixture', tokens: { base: 'dark', radius: 8 },
    expectedVersion: 1, expectedWorkspaceRevision: 2, idempotencyKey: 'append-calm' });
  assert.equal(appended.version.version, 2);
  assert.equal(appended.version.tokens.radius, 8);
  assert.equal(appended.theme.base, 'dark');
  const rolledBack = store.rollback({ themeId: 'calm', canvasId: 'fixture', targetVersion: 1,
    expectedVersion: 2, expectedWorkspaceRevision: 3, idempotencyKey: 'rollback-calm' });
  assert.equal(rolledBack.version.version, 3);
  assert.equal(rolledBack.version.tokens.radius, 4);
  assert.equal(rolledBack.theme.base, 'light');
  const disabled = store.disable({ canvasId: 'fixture', expectedWorkspaceRevision: 4, idempotencyKey: 'disable-theme' });
  assert.equal(disabled.workspace.active, null);
  store.close();
  store = openThemeStore(path);
  assert.equal(store.get('calm', 3).version.tokens.radius, 4);
  assert.equal(store.workspace('fixture').active, null);
  store.close();
});

test('agent proposals stay inert until activation and can be rejected without changing the theme', async t => {
  const { path } = await fixture(t);
  const store = openThemeStore(path);
  const before = store.workspace('fixture');
  const proposal = store.create({ id: 'agent-theme', canvasId: 'fixture', origin: 'agent', name: 'Agent theme', base: 'dark', tokens: {},
    idempotencyKey: 'agent-proposal' });
  assert.equal(proposal.theme.state, 'PROPOSED');
  assert.equal(proposal.workspace.active, null);
  assert.equal(proposal.workspace.revision, before.revision);
  assert.equal(store.workspace('fixture').proposals.length, 1);
  const activated = store.activate({ themeId: 'agent-theme', canvasId: 'fixture', expectedVersion: 1,
    expectedWorkspaceRevision: 1, idempotencyKey: 'accept-agent-theme' });
  assert.equal(activated.theme.state, 'SAVED');
  assert.equal(activated.workspace.active.version.tokens.base, 'dark');
  const second = store.create({ id: 'reject-me', canvasId: 'fixture', origin: 'agent', name: 'Reject me', tokens: {}, idempotencyKey: 'agent-reject' });
  assert.equal(store.reject({ themeId: second.theme.id, expectedVersion: 1, idempotencyKey: 'reject-agent-theme' }).theme.state, 'REJECTED');
  assert.throws(() => store.activate({ themeId: second.theme.id, canvasId: 'fixture', expectedVersion: 1,
    expectedWorkspaceRevision: 2, idempotencyKey: 'activate-rejected' }), error => error.code === 'REVISION_CONFLICT');
  store.close();
});
