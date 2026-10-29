import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createHubClient } from './hub-client.mjs';

test('App SSR keeps Chats usable and hides optional modules pending capability discovery', async () => {
  const vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  try {
    const { default: App } = await vite.ssrLoadModule('/App.jsx');
    const { default: Canvas } = await vite.ssrLoadModule('/Canvas.jsx');
    const requests = [];
    const bearer = 'synthetic-ssr-fixture-not-a-user-credential';
    const client = createHubClient({ baseUrl: 'http://127.0.0.1:46231', bearer, fetch: async (url, init) => {
      requests.push({ method: init.method, path: new URL(url).pathname });
      throw new Error('UNEXPECTED_SSR_NETWORK');
    } });
    const cards = [{ id: 'card-a', canvasId: 'fixture', sessionId: 'session-a', title: 'Chat A', x: 0, y: 0, revision: 1 }];
    const html = renderToStaticMarkup(React.createElement(App, { client, cards }));
    assert.match(html, /Workspace views/);
    assert.match(html, /^<main class="aylachi workspace-app" data-theme="light" style="[^"]*">/);
    assert.equal((html.match(/<main(?:\s|>)/g) ?? []).length, 1, 'connected workspace has exactly one main landmark');
    assert.equal((html.match(/<button[^>]*aria-label="Settings"/g) ?? []).length, 1, 'one shared settings control, not a nested Canvas control');
    const darkCanvas = renderToStaticMarkup(React.createElement(Canvas, { cards, theme: 'dark' }));
    assert.match(darkCanvas, /data-theme="dark"/);
    assert.doesNotMatch(darkCanvas, /<main(?:\s|>)/, 'controlled canvas must not nest a main landmark inside Workspace');
    assert.doesNotMatch(darkCanvas, /Theme: /, 'controlled canvas inherits the shared workspace theme');
    const nullCanvas = renderToStaticMarkup(React.createElement(Canvas, { cards, theme: null }));
    assert.equal((nullCanvas.match(/<main(?:\s|>)/g) ?? []).length, 1, 'null theme uses the standalone landmark');
    assert.equal((nullCanvas.match(/Theme: /g) ?? []).length, 1, 'null theme retains the local theme control');
    assert.match(nullCanvas, /data-theme="light"/);
    assert.match(html, /id="chats-panel"/);
    assert.doesNotMatch(html, /wiki-tab|wiki-panel|Wiki pane|Note content/);
    assert.doesNotMatch(html, /handoff-tab|handoff-panel|Manual handoff|Source card|Command ID|Target card|Send transfer/);
    assert.deepEqual(requests, [], 'SSR must not invoke transport reads or mutations');
    assert.ok(!html.includes(bearer));
    const disconnected = renderToStaticMarkup(React.createElement(App, { cards, bootstrapError: 'Test disconnected' }));
    assert.match(disconnected, /Test disconnected/);
    assert.equal((disconnected.match(/<main(?:\s|>)/g) ?? []).length, 1, 'standalone canvas retains its main landmark');
    assert.equal((disconnected.match(/Theme: /g) ?? []).length, 1, 'standalone disconnected canvas retains its control');
    assert.ok(!disconnected.includes('Workspace views'));
    assert.doesNotMatch(disconnected, /handoff-tab|Manual handoff|Send transfer/);
    assert.deepEqual(requests, []);
    let moves = 0;
    for (const code of ['INVALID_POSITION', 'MOVE_UNAVAILABLE', 'CONFLICT', 'OUTCOME_UNKNOWN']) {
      const positionHtml = renderToStaticMarkup(React.createElement(Canvas, {
        cards, positionErrorByCard: { 'card-a': code, absent: 'HIDDEN_ERROR' },
        onMove: () => { moves++; },
      }));
      assert.match(positionHtml, /role="alert"/);
      assert.ok(positionHtml.includes(`Update for Chat A: ${code}`));
      assert.match(positionHtml, /No automatic retry/);
      assert.doesNotMatch(positionHtml, /Refresh the current position|HIDDEN_ERROR/);
    }
    assert.equal(moves, 0, 'render must not perform a move or retry');
  } finally { await vite.close(); }
});
