import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createHubClient } from './hub-client.mjs';
import { orderedFocusIds, projectLocalCanvas } from './local-view.mjs';

test('workspace status and node controls stay truthful and preserve user input', async () => {
  const vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  try {
    const { default: App } = await vite.ssrLoadModule('/App.jsx');
    const { default: Canvas } = await vite.ssrLoadModule('/Canvas.jsx');
    const client = createHubClient({ baseUrl: 'http://127.0.0.1:46231', bearer: 'synthetic-ssr-fixture-not-a-user-credential', fetch: async () => { throw new Error('UNEXPECTED_SSR_NETWORK'); } });
    const cards = [{ id: 'card-a', canvasId: 'fixture', sessionId: 'session-a', title: 'Chat A', x: 0, y: 0, revision: 1 }];
    const html = renderToStaticMarkup(React.createElement(App, { client, cards }));
    assert.doesNotMatch(html, /workspace-bar|Hub workspace/, 'empty workspace bar is removed');
    assert.doesNotMatch(html, /Hub connected|status-dot/, 'static chrome must not claim health before capabilities or Graph load');

    const canvas = renderToStaticMarkup(React.createElement(Canvas, { cards, graph: { nodes: [], edges: [], runs: [], artifacts: [] },
      graphWikiEnabled: false, onCreateGraphNode: () => {} }));
    assert.match(canvas, /aria-label="Add node"/, 'node types share one progressive-disclosure entry point');
    assert.doesNotMatch(canvas, /Focus node|>Collapse</, 'focus uses Cmd+F instead of a toolbar selector');
    assert.doesNotMatch(canvas, /option value="wiki"/, 'Wiki creation follows its advertised capability');
    assert.match(canvas, /title="Run all available Wiki and Artifact previews"/, 'disabled run controls explain their scope');
    const wikiCanvas = renderToStaticMarkup(React.createElement(Canvas, { cards, graph: { nodes: [], edges: [], runs: [], artifacts: [] },
      graphWikiEnabled: true, onCreateGraphNode: () => {} }));
    assert.match(wikiCanvas, /option value="wiki"/, 'Wiki remains available when its capability is enabled');
    const emptyCanvas = renderToStaticMarkup(React.createElement(Canvas, { cards: [], graph: { nodes: [], edges: [], runs: [], artifacts: [] } }));
    assert.match(emptyCanvas, /Create a node to start/, 'empty state stays generic instead of listing only a subset of node types');

  } finally { await vite.close(); }
});

test('chat footer shows actual model usage and focused chat keeps icon and exit controls', async () => {
  const vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  try {
    const { ChatCard, formatTokens, focusScaleShortcut, focusContentStyle } = await vite.ssrLoadModule('/ChatCard.jsx');
    const { nodeIconOptions } = await vite.ssrLoadModule('/Icon.jsx');
    const { isFocusShortcut, focusNavigationDirection, wheelGestureDirection } = await vite.ssrLoadModule('/Canvas.jsx');
    const card = { id: 'card-a', canvasId: 'fixture', sessionId: 'session-a', title: 'Chat A', x: 0, y: 0, revision: 1 };
    const modelCatalog = { models: [{ provider: 'openai-codex', id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 128000 }], default: { provider: 'openai-codex', modelId: 'gpt-6-luna', reasoning: 'low' } };
    const html = renderToStaticMarkup(React.createElement(ChatCard, { card, modelCatalog, onUpdateModel: () => {}, focused: true,
      metrics: { input: 30000, output: 1200, cacheRead: 1568, cacheWrite: 0, totalTokens: 32768, durationMs: 20000 } }));
    assert.match(html, /32\.8k \/ 128k · 26%/);
    assert.match(html, /60 tok\/s/);
    assert.match(html, /chat-card-focused/);
    assert.match(html, /class="chat-card-content" style="width:100%;height:100%;transform:scale\(1\);transform-origin:top left"/, 'focus content uses stable transforms instead of WKWebView zoom');
    assert.deepEqual(focusContentStyle(true, 1.25), { width: '80%', height: '80%', transform: 'scale(1.25)', transformOrigin: 'top left' },
      'enlarged content is laid out inversely so its scaled box still exactly fits focus');
    assert.deepEqual(focusContentStyle(true, 0.8), { width: '125%', height: '125%', transform: 'scale(0.8)', transformOrigin: 'top left' });
    assert.deepEqual(focusContentStyle(false, 1.8), { width: '100%', height: '100%', transform: 'scale(1)', transformOrigin: 'top left' },
      'leaving focus always restores the ordinary node regardless of its remembered focus scale');
    assert.equal(focusScaleShortcut({ metaKey: true, key: '=' }, 1), 1.1);
    assert.equal(focusScaleShortcut({ metaKey: true, key: '+' }, 1.1), 1.2);
    assert.equal(focusScaleShortcut({ ctrlKey: true, key: '-' }, 1), 0.9);
    assert.equal(focusScaleShortcut({ metaKey: true, key: '0' }, 1.7), 1);
    assert.equal(focusScaleShortcut({ metaKey: true, key: '=' }, 2), 2);
    assert.equal(focusScaleShortcut({ metaKey: true, key: '-' }, 0.7), 0.7);
    assert.equal(focusScaleShortcut({ key: '=' }, 1), null, 'ordinary typing is never rewritten as a zoom shortcut');
    assert.match(html, /Exit focus/);
    assert.match(html, /Choose node icon/);
    assert.ok(nodeIconOptions.length >= 30);
    assert.equal(formatTokens(900), '900');
    assert.equal(isFocusShortcut({ metaKey: true, key: 'f' }), true);
    assert.equal(isFocusShortcut({ ctrlKey: true, key: 'F' }), true);
    assert.equal(isFocusShortcut({ key: 'f' }), false);
    assert.equal(focusNavigationDirection({ metaKey: true, key: 'ArrowRight' }), 1);
    assert.equal(focusNavigationDirection({ ctrlKey: true, key: 'ArrowLeft' }), -1);
    assert.equal(focusNavigationDirection({ metaKey: true, key: 'ArrowRight', target: { closest: () => ({}) } }), 0,
      'text editing keeps native Cmd+Arrow behavior');
    assert.equal(wheelGestureDirection({ deltaX: 12, deltaY: 4 }), 'pan');
    assert.equal(wheelGestureDirection({ deltaX: 2, deltaY: 9 }, 'pan', 80), 'pan',
      'diagonal jitter cannot switch a single swipe between pan and transcript scroll');
    assert.equal(wheelGestureDirection({ deltaX: 2, deltaY: 9 }, 'pan', 200), 'scroll',
      'a later vertical gesture still scrolls the transcript');
  } finally { await vite.close(); }
});

test('focus projects ordered full-size columns without changing source layout or unmounting siblings', () => {
  const nodes = [
    { id: 'right', position: { x: 900, y: 0 }, style: { width: 460, height: 520 }, data: {} },
    { id: 'left', position: { x: 0, y: 0 }, style: { width: 460, height: 520 }, data: {} },
    { id: 'middle', position: { x: 450, y: 20 }, style: { width: 460, height: 520 }, data: {} },
  ];
  assert.deepEqual(orderedFocusIds(nodes), ['left', 'middle', 'right']);
  const projected = projectLocalCanvas(nodes, [{ id: 'edge' }], { focusedNodeId: 'middle', focusSize: { width: 800, height: 600 } });
  assert.deepEqual(projected.nodes.map(node => node.position), [{ x: 1664, y: 0 }, { x: 0, y: 0 }, { x: 832, y: 0 }]);
  assert.ok(projected.nodes.every(node => !node.hidden && node.style.width === 800 && node.style.height === 600),
    'siblings stay mounted off-screen and every column uses the available canvas size');
  assert.deepEqual(projected.edges, []);
  assert.deepEqual(nodes.map(node => node.position.x), [900, 0, 450], 'source coordinates are not mutated');
  assert.equal(projected.nodes.find(node => node.id === 'middle').data.focused, true);
  const ordinary = projectLocalCanvas(nodes, [{ id: 'edge' }]);
  assert.deepEqual(ordinary.nodes.map(node => node.position.x), [900, 0, 450]);
  assert.equal(ordinary.edges.length, 1);
});
