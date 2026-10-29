import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const node = { id: 'node', canvasId: 'fixture', kind: 'artifact', refId: 'node', title: 'Plan', x: 0, y: 0, width: 520, height: 520, revision: 1,
  settings: { content: '# Plan\n\n```mermaid\ngraph LR\n A-->B\n```', format: 'markdown' } };

test('Graph Node opens rendered Preview with a secondary Source action and safe Mermaid', async () => {
  const vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  try {
    const { GraphNode, HtmlArtifactPreview } = await vite.ssrLoadModule('/GraphNode.jsx');
    const { Markdown } = await vite.ssrLoadModule('/Markdown.jsx');
    const loading = renderToStaticMarkup(React.createElement(HtmlArtifactPreview, { title: 'HTML', artifactId: 'v1', content: null }));
    assert.match(loading, /Loading preview/);
    assert.doesNotMatch(loading, /<iframe/);
    const empty = renderToStaticMarkup(React.createElement(HtmlArtifactPreview, { title: 'HTML', artifactId: 'v1', content: '' }));
    assert.match(empty, /<iframe[^>]*sandbox=""/, 'an empty HTML document is rendered, not stuck in loading');
    const ready = renderToStaticMarkup(React.createElement(HtmlArtifactPreview, { title: 'HTML', artifactId: 'v1', content: '<h1>Safe artifact</h1>' }));
    assert.match(ready, /<iframe[^>]*sandbox=""/);
    assert.match(ready, /Content-Security-Policy/);
    assert.match(ready, /Safe artifact/);
    const html = renderToStaticMarkup(React.createElement(GraphNode, { data: { node, hubClient: { moduleRequest: async () => { throw new Error('unexpected'); } },
      graphClient: {}, artifacts: [], runs: [], onRun: () => {}, onUpdateArtifact: () => {} } }));
    for (const text of ['Plan', 'Source', 'Run node', 'Run branch', 'graph LR']) assert.match(html, new RegExp(text));
    assert.match(html, /graph-source-button/);
    assert.doesNotMatch(html, /graph-editor/, 'source editor is not the default view');
    const mermaid = renderToStaticMarkup(React.createElement(Markdown, { text: '```mermaid\ngraph LR\n A-->B\n```\n<script>alert(1)</script>', mermaid: true }));
    assert.match(mermaid, /mermaid-loading/);
    assert.match(mermaid, /graph LR/);
    assert.doesNotMatch(mermaid, /<script/);
  } finally { await vite.close(); }
});
