import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startDevelopmentServer } from './server.mjs';
import { snapshotDevelopmentState, restoreDevelopmentState } from './offline-snapshot.mjs';
import { openBrowserStore } from '../browser/store.mjs';
import { openThemeStore } from '../themes/store.mjs';

test('offline snapshot restores browser snapshots and active theme versions with exact schemas', async t => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'aylachi-m7-offline-'));
  await chmod(parent, 0o700);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'state');
  const app = await startDevelopmentServer({ stateRoot: root, port: 0 });
  await app.shutdown();
  const browser = openBrowserStore(join(root, 'browser.sqlite'));
  browser.create({ id: 'session', canvasId: 'fixture', mode: 'remote-read-only', backendId: 'remote-read-only', policy: { allowedHosts: ['example.com'] },
    tab: { id: 'tab', url: 'https://example.com/', title: 'Example', snapshot: { id: 'snapshot', url: 'https://example.com/', title: 'Example', text: 'Durable browser text', links: [] } }, idempotencyKey: 'browser-create' });
  browser.close();
  const themes = openThemeStore(join(root, 'themes.sqlite'));
  themes.create({ id: 'calm', canvasId: 'fixture', origin: 'user', name: 'Calm', base: 'light', tokens: { radius: 6 }, expectedWorkspaceRevision: 1, idempotencyKey: 'theme-create' });
  themes.close();
  const snapshotRoot = join(parent, 'snapshot');
  const snapshot = await snapshotDevelopmentState({ stateRoot: root, snapshotRoot });
  const restoreRoot = join(parent, 'restored');
  await restoreDevelopmentState({ snapshotRoot, restoreRoot, expectedManifestSha256: snapshot.manifestSha256 });
  const restoredBrowser = openBrowserStore(join(restoreRoot, 'browser.sqlite'));
  assert.equal(restoredBrowser.read('session').snapshots[0].text, 'Durable browser text');
  restoredBrowser.close();
  const restoredThemes = openThemeStore(join(restoreRoot, 'themes.sqlite'));
  assert.equal(restoredThemes.workspace('fixture').active.version.tokens.radius, 6);
  restoredThemes.close();
});
