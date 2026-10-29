import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createBrowserClient } from './browser-client.mjs';
import { createThemeClient } from './theme-client.mjs';
import { createGraphClient } from './graph-client.mjs';

test('M7 Node Views render safe initial states without SSR transport or raw HTML', async () => {
  const vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  try {
    const { BrowserNode } = await vite.ssrLoadModule('/BrowserNode.jsx');
    const { ThemeNode } = await vite.ssrLoadModule('/ThemeNode.jsx');
    const hubClient = { moduleRequest: async () => { throw new Error('UNEXPECTED_SSR_NETWORK'); } };
    const node = { id: 'browser-node', refId: 'session', title: 'Docs', revision: 1 };
    const browser = renderToStaticMarkup(React.createElement(BrowserNode, { data: { node, hubClient } }));
    assert.match(browser, /BROWSER · LOADING/);
    assert.match(browser, /Loading browser…/);
    assert.doesNotMatch(browser, /browser-policy/);
    assert.doesNotMatch(browser, /<iframe|<script|javascript:/);
    const theme = renderToStaticMarkup(React.createElement(ThemeNode, { data: { hubClient } }));
    assert.match(theme, /DECLARATIVE TOKENS/);
    assert.match(theme, /Theme background/);
    assert.doesNotMatch(theme, /<script|javascript:/);
    const settings = renderToStaticMarkup(React.createElement(ThemeNode, { data: { hubClient, settings: true } }));
    assert.match(settings, /Appearance/);
    assert.equal((settings.match(/class="theme-preset"/g) ?? []).length, 6, 'six built-in presets are available in Settings');
    assert.doesNotMatch(settings, /DECLARATIVE TOKENS|Theme Editor/);
  } finally { await vite.close(); }
});

test('M7 clients preserve proposal routes and accept Browser/Theme Graph definitions', async () => {
  const calls = [];
  const hubClient = { moduleRequest: async input => {
    calls.push(input);
    if (input.path === '/v1/modules/workspace/graph/nodes') return { node: { id: `node-${input.body.kind}`, canvasId: 'fixture', kind: input.body.kind,
      refId: 'ref', title: input.body.title, x: 0, y: 0, width: 520, height: 520, revision: 1, settings: {} } };
    if (input.path === '/v1/modules/browser/sessions/session') return { session: { id: 'session', revision: 1, activeTabId: 'tab' }, tabs: [], snapshots: [] };
    return { theme: { id: 'proposal', state: 'REJECTED' } };
  } };
  const graph = createGraphClient({ hubClient });
  assert.equal((await graph.createNode({ kind: 'browser', title: 'Browser' })).node.kind, 'browser');
  assert.equal((await graph.createNode({ kind: 'theme', title: 'Theme' })).node.kind, 'theme');
  await createBrowserClient({ hubClient }).read('session');
  await createThemeClient({ hubClient }).reject('proposal', { expectedVersion: 1, idempotencyKey: 'reject' });
  assert.equal(calls.at(-1).path, '/v1/modules/themes/proposals/proposal/reject');
});
