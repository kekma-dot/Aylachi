import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const browserClient = String.raw`
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeNode } from '/ThemeNode.jsx';
import { BrowserNode } from '/BrowserNode.jsx';
import Canvas from '/Canvas.jsx';
import { GraphNode } from '/GraphNode.jsx';

const tokens = { base: 'dark', colors: { background: '#112233', surface: '#302e35', text: '#eeeaf0', muted: '#aaa2ad', accent: '#c4b2e0', border: '#4b4750', accentSoft: '#40394a', accentStrong: '#554865' }, radius: 4,
  shadow: { x: 7, y: 7, blur: 0, color: '#000000', opacity: 0.2 }, typography: { family: 'system', size: 14 }, density: 'comfortable' };
const workspace = { canvasId: 'fixture', revision: 7, active: { theme: { id: 'calm', name: 'Calm', currentVersion: 3 }, version: { version: 3, tokens } }, themes: [{ id: 'preset-paper', name: 'Paper', currentVersion: 1 }], proposals: [] };
let browser = { session: { id: 'session', canvasId: 'fixture', mode: 'remote-read-only', revision: 1, activeTabId: 'tab-1' },
  tabs: [{ id: 'tab-1', sessionId: 'session', url: 'https://example.com/', title: 'Example' }],
  snapshots: [{ id: 'snapshot-1', tabId: 'tab-1', url: 'https://example.com/', title: 'Example', text: 'Example Domain', links: [] }] };
const openTabCalls = [], createdNodes = [], presetCalls = [], activateCalls = [];
const artifactNode = { id: 'artifact-node', refId: 'artifact-node', kind: 'artifact', title: 'Rendered artifact', revision: 1, settings: { content: '', format: 'markdown' } };
const artifactClient = { node: async () => ({ node: { ...artifactNode, settings: { ...artifactNode.settings, content: '# Loaded preview' } } }) };
const hubClient = { moduleRequest: async ({ method, path, body }) => {
  if (method === 'GET' && path === '/v1/modules/themes') return workspace;
  if (method === 'GET' && path === '/v1/modules/browser/sessions/session') return browser;
  if (method === 'POST' && path === '/v1/modules/themes/preset-paper/activate') {
    activateCalls.push(body);
    return { theme: { id: 'preset-paper', name: 'Paper', currentVersion: 1 }, version: { version: 1, tokens }, workspace: { ...workspace, revision: workspace.revision + 2, active: { theme: { id: 'preset-paper', name: 'Paper', currentVersion: 1 }, version: { version: 1, tokens } } } };
  }
  if (method === 'POST' && path === '/v1/modules/themes') {
    presetCalls.push(body);
    return { theme: { id: 'preset-theme', name: body.name, currentVersion: 1 }, version: { version: 1, tokens: body.tokens }, workspace: { ...workspace, revision: workspace.revision + 1, active: { theme: { id: 'preset-theme', name: body.name, currentVersion: 1 }, version: { version: 1, tokens: body.tokens } } } };
  }
  if (method === 'POST' && path === '/v1/modules/browser/sessions/session/tabs') {
    openTabCalls.push(body);
    browser = { session: { ...browser.session, revision: 2, activeTabId: 'tab-2' },
      tabs: [...browser.tabs, { id: 'tab-2', sessionId: 'session', url: body.url, title: 'Example' }],
      tab: { id: 'tab-2', sessionId: 'session', url: body.url, title: 'Example' },
      snapshot: { id: 'snapshot-2', tabId: 'tab-2', url: body.url, title: 'Example', text: 'Example Domain', links: [] } };
    return browser;
  }
  throw new Error('Unexpected fixture request: ' + method + ' ' + path);
} };
let initialRollback, artifactPreviewDefault = false, artifactSourceOnDemand = false, trackpadPanned = false, draftPreservedAfterBase = false, baseChangedAfterEdit = false;
function report() {
  const value = selector => document.querySelector(selector)?.value;
  const newTab = document.querySelector('button[aria-label="Open address in new tab"]');
  const data = { base: value('select[aria-label="Theme base"]'), background: value('input[aria-label="Theme background"]'),
    rollback: value('select[aria-label="Theme rollback version"]'), initialRollback, newTabTitle: newTab?.title, openTabCalls, createdNodes,
    addNodeValue: value('select[aria-label="Add node"]'), presetCalls, artifactPreviewDefault, artifactSourceOnDemand, trackpadPanned };
  data.assertions = { initialRollbackIsNearest: initialRollback === '2', baseChanged: baseChangedAfterEdit,
    draftPreserved: draftPreservedAfterBase, newTabExplained: data.newTabTitle === 'Open address in new tab',
    openTabUsedAddress: openTabCalls.length === 1 && openTabCalls[0].url === 'https://example.com/' && openTabCalls[0].expectedRevision === 1,
    addNodeWorks: createdNodes.length === 2 && createdNodes.every(kind => kind === 'artifact') && data.addNodeValue === '',
    presetApplied: presetCalls.length === 1 && presetCalls[0].id === 'preset-aylachi-light' && activateCalls.length === 1 && activateCalls[0].expectedWorkspaceRevision === 8,
    artifactOpensRendered: artifactPreviewDefault && artifactSourceOnDemand,
    twoFingerScrollPans: trackpadPanned,
    themeCreationRemoved: !document.querySelector('option[value="theme"]') };
  const output = document.getElementById('report');
  output.textContent = JSON.stringify(data, null, 2);
  output.dataset.pass = Object.values(data.assertions).every(Boolean) ? 'true' : 'false';
  return data;
}
window.__usabilityReport = report;
async function selfCheck() {
  await new Promise(resolve => setTimeout(resolve, 300));
  initialRollback = document.querySelector('select[aria-label="Theme rollback version"]')?.value;
  artifactPreviewDefault = Boolean(document.querySelector('.graph-preview')?.textContent.includes('Loaded preview') && !document.querySelector('.graph-editor'));
  const flow = document.querySelector('.react-flow__pane');
  const viewport = document.querySelector('.react-flow__viewport');
  const beforePan = viewport?.style.transform;
  flow?.dispatchEvent(new WheelEvent('wheel', { deltaX: 48, deltaY: 32, bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 100));
  trackpadPanned = Boolean(viewport && beforePan !== viewport.style.transform);
  const base = document.querySelector('select[aria-label="Theme base"]');
  base.value = 'light'; base.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  baseChangedAfterEdit = base.value === 'light';
  draftPreservedAfterBase = document.querySelector('input[aria-label="Theme background"]').value === '#112233';
  document.querySelector('button[aria-label="Open address in new tab"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  const addNode = document.querySelector('select[aria-label="Add node"]');
  for (let index = 0; index < 2; index++) {
    addNode.value = 'artifact'; addNode.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  document.querySelector('button[aria-label="Apply Aylachi Light theme"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  document.querySelector('button[aria-label="Apply Paper theme"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  document.querySelector('.graph-source-button').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  artifactSourceOnDemand = Boolean(document.querySelector('.graph-editor'));
  return report();
}
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
  React.createElement(ThemeNode, { data: { hubClient, settings: true } }),
  React.createElement(BrowserNode, { data: { node: { id: 'browser-node', refId: 'session', title: 'Docs', revision: 1 }, hubClient } }),
  React.createElement(Canvas, { cards: [], graph: { nodes: [], edges: [], runs: [], artifacts: [] }, graphWikiEnabled: true,
    graphBrowserEnabled: true, graphThemesEnabled: true, onCreateGraphNode: kind => { createdNodes.push(kind); } }),
  React.createElement(GraphNode, { data: { node: artifactNode, hubClient, graphClient: artifactClient, artifacts: [], runs: [], onRun: () => {}, onUpdateArtifact: () => {} } }),
));
addEventListener('input', () => setTimeout(report, 0));
addEventListener('change', () => setTimeout(report, 0));
addEventListener('click', () => setTimeout(report, 50));
setTimeout(selfCheck, 150);
`;

async function startBrowser() {
  const { createServer } = await import('vite');
  const reactPlugin = (await import('@vitejs/plugin-react')).default;
  const plugin = {
    name: 'usability-browser-regression',
    resolveId(id) { return id === 'virtual:usability-browser' ? '\0usability-browser' : null; },
    load(id) { return id === '\0usability-browser' ? browserClient : null; },
    configureServer(server) {
      server.middlewares.use('/__usability-test', (_req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>Aylachi usability regression</title></head><body><div id="root"></div><pre id="report" role="status">Waiting for React…</pre><script type="module" src="/@id/__x00__usability-browser"></script></body></html>');
      });
    },
  };
  const server = await createServer({ configFile: false, root, plugins: [reactPlugin(), plugin], resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 4178, strictPort: true, hmr: false, ws: false }, appType: 'custom' });
  await server.listen();
  console.log('Open http://127.0.0.1:4178/__usability-test');
  process.on('SIGINT', async () => { await server.close(); process.exit(0); });
}

if (process.argv.includes('--browser')) await startBrowser();
else test('interactive usability fixture is available via --browser', () => {
  assert.ok(browserClient.includes('select[aria-label="Theme base"]'));
  assert.ok(browserClient.includes('input[aria-label="Theme background"]'));
  assert.ok(browserClient.includes('select[aria-label="Theme rollback version"]'));
  assert.ok(browserClient.includes('openTabCalls.push(body)'));
  assert.ok(browserClient.includes('output.dataset.pass'));
  assert.ok(browserClient.includes('draftPreserved: draftPreservedAfterBase'));
  assert.ok(browserClient.includes('openTabUsedAddress: openTabCalls.length === 1'));
  assert.ok(browserClient.includes('addNodeWorks: createdNodes.length === 2'));
});
