import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { projectLocalCanvas } from './local-view.mjs';

test('unknown plugin uses generic node and Hub Activity Center', async () => {
  const vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  try {
    const { default: PluginNode } = await vite.ssrLoadModule('/PluginNode.jsx');
    const { default: ActivityCenter } = await vite.ssrLoadModule('/ActivityCenter.jsx');
    const node = { id: 'unknown', title: 'Unknown provider', settings: { toolName: 'acme.unseen.transform', input: { value: 'hello' } } };
    const activities = [{ nodeId: 'unknown', commandId: 'command-1', toolName: 'acme.unseen.transform', state: 'SUCCEEDED', result: { text: 'HELLO' } }];
    const html = renderToStaticMarkup(React.createElement(PluginNode, { data: { node, activities, onTrigger: () => {} } }));
    assert.match(html, /acme\.unseen\.transform/); assert.match(html, /Trigger/); assert.match(html, /SUCCEEDED/);
    const center = renderToStaticMarkup(React.createElement(ActivityCenter, { activities }));
    assert.match(center, /<details class="activity-center">/);
    assert.match(center, /<summary>Activity<\/summary>/);
    assert.doesNotMatch(center, /<details[^>]* open/);
    assert.match(center, /Activity Center/); assert.match(center, /HELLO/);
  } finally { await vite.close(); }
});

test('Focus and Collapse are local projections that preserve nodes, pipes and runtime', () => {
  const nodes = [{ id: 'a', style: { width: 520, height: 520 }, data: {} }, { id: 'b', style: { width: 520, height: 520 }, data: {} }];
  const edges = [{ id: 'pipe', source: 'a', target: 'b' }], runs = [{ id: 'run', status: 'RUNNING' }];
  const collapsed = projectLocalCanvas(nodes, edges, { collapsedIds: new Set(['a']) });
  assert.equal(collapsed.nodes[0].style.height, 72); assert.equal(collapsed.nodes[0].data.collapsed, true);
  assert.equal(collapsed.edges, edges); assert.equal(nodes[0].style.height, 520); assert.equal(runs[0].status, 'RUNNING');
  const positioned = nodes.map((node, index) => ({ ...node, position: { x: index * 560, y: 0 } }));
  const focused = projectLocalCanvas(positioned, edges, { focusedNodeId: 'a', focusSize: { width: 800, height: 600 } });
  assert.ok(focused.nodes.every(node => !node.hidden && node.style.width === 800 && node.style.height === 600));
  assert.deepEqual(focused.nodes.map(node => node.position), [{ x: 0, y: 0 }, { x: 832, y: 0 }]);
  assert.deepEqual(focused.edges, []); assert.deepEqual(positioned.map(node => node.position.x), [0, 560]);
});
