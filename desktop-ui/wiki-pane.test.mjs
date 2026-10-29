import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let WikiPane;
before(async () => {
  vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  ({ default: WikiPane } = await vite.ssrLoadModule('/WikiPane.jsx'));
});
after(async () => { await vite?.close(); });

const id = '11111111-1111-4111-8111-111111111111';
const revision = '22222222-2222-4222-8222-222222222222';
const linkedId = '33333333-3333-4333-8333-333333333333';
const calls = [];
const transferCalls = [];
const actions = Object.fromEntries(['search', 'openNote', 'newNote', 'edit', 'save', 'loadHistory', 'compare', 'restore', 'reconcile']
  .map(name => [name, (...args) => calls.push([name, ...args])]));
function fixture(overrides = {}) {
  return {
    notes: [{ id, title: 'Field notes', revision }],
    selected: { id, revision, content: 'saved content' },
    draft: '<script>do not execute</script>', dirty: true,
    history: [revision], changes: [{ start: 2, remove: ['old line\n'], insert: ['new line\n'] }], links: [linkedId],
    busy: false, error: 'Save conflict', conflict: true, uncertain: false,
    ...overrides,
  };
}
function render(state, onTransferSource) { return renderToStaticMarkup(React.createElement(WikiPane, { state, actions, onTransferSource })); }
function button(html, label) { return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] || ''; }

test('SSR renders accessible search/open/create/editor/history/diff/restore/links without executing actions or HTML', () => {
  calls.length = 0;
  const html = render(fixture({ conflict: false, error: null }));
  for (const text of ['Wiki pane', 'Search notes', 'Search', 'Discard draft / New note', 'Open note Field notes', 'Note content', 'Save', 'Revision history', 'Load history', 'Compare selected revision', 'Restore revision', 'Revision diff', 'Links', linkedId]) {
    assert.ok(html.includes(text), `missing rendered text: ${text}`);
  }
  assert.ok(html.includes('&lt;script&gt;do not execute&lt;/script&gt;'));
  assert.ok(!html.includes('<script>do not execute</script>'));
  assert.ok(button(html, 'New note').includes('disabled=""'), 'new-note + cannot silently discard a dirty draft');
  assert.match(html, />Discard</, 'draft destruction requires a separate visible action');
  assert.equal(calls.length, 0, 'SSR must not invoke controller actions');
});

test('manual handoff controls are absent from the Wiki workspace', () => {
  calls.length = 0;
  transferCalls.length = 0;
  const html = render(fixture({ dirty: false, busy: false, uncertain: false, conflict: false, error: null }), payload => transferCalls.push(payload));
  assert.doesNotMatch(html, /Transfer saved revision|Source card|Target card|Send transfer/);
  assert.equal(transferCalls.length, 0);
  assert.equal(calls.length, 0, 'SSR never invokes controller actions');
});

test('new-note mode renders dirty draft with enabled Save and no fabricated revision', () => {
  calls.length = 0;
  const html = render(fixture({ selected: null, draft: 'new draft', dirty: true, history: [], changes: [], links: [], conflict: false, error: null }));
  assert.match(html, /<h2>New note<\/h2>/);
  assert.match(html, />new draft<\/textarea>/);
  assert.doesNotMatch(html, /wiki-pane-revision|Revision <code>/);
  const save = button(html, 'Save note');
  assert.ok(save && !save.includes('disabled'), 'new-note Save should be enabled for a dirty draft');
  assert.equal(calls.length, 0, 'render must not autosave');
});

test('uncertain outcome copy is honest and writes remain locked', () => {
  const html = render(fixture({ busy: false, uncertain: true, conflict: false, error: null }));
  assert.match(html, /Outcome unknown; writes stay locked; reconciliation only refreshes authoritative state\./);
  assert.doesNotMatch(html, /Reconcile before retrying/);
  assert.ok(button(html, 'Save note').includes('disabled=""'));
  assert.ok(button(html, `Restore revision ${revision}`).includes('disabled=""'));
  assert.match(html, />Reconcile outcome</);
});

test('conflict preserves draft, locks Save/Restore, and offers server-revision refresh', () => {
  const dirty = render(fixture({ busy: false, uncertain: false, conflict: true, error: null }));
  assert.match(dirty, /Conflict detected\. The draft is preserved; Save and Restore are locked/);
  const refresh = dirty.match(/<button[^>]*>Refresh server revision<\/button>/)?.[0] || '';
  assert.ok(refresh && !refresh.includes('disabled'), 'conflict must offer an enabled authoritative refresh');
  assert.ok(dirty.includes('&lt;script&gt;do not execute&lt;/script&gt;'));
  assert.ok(button(dirty, 'Save note').includes('disabled=""'));
  const clean = render(fixture({ dirty: false, busy: false, uncertain: false, conflict: true, error: null }));
  assert.ok(button(clean, `Restore revision ${revision}`).includes('disabled=""'));
  assert.ok(!button(clean, 'Refresh server revision').includes('disabled=""'));
  assert.equal(calls.length, 0, 'SSR must not invoke reconcile or write actions');
});

test('busy disables search and both open controls; idle re-enables them without invoking actions', () => {
  calls.length = 0;
  const busy = render(fixture({ busy: true, uncertain: false, conflict: false }));
  assert.match(busy, /id="wiki-pane-query"[^>]*disabled=""/);
  assert.ok(busy.match(/<button[^>]*class="wiki-pane-note"[^>]*>/)?.[0].includes('disabled=""'));
  assert.ok(busy.match(/<button[^>]*class="wiki-pane-link"[^>]*>/)?.[0].includes('disabled=""'));
  assert.ok(button(busy, 'Save note').includes('disabled=""'));
  assert.ok(button(busy, `Restore revision ${revision}`).includes('disabled=""'));
  assert.match(busy, /id="wiki-pane-editor"[^>]*disabled=""/);

  const idle = render(fixture({ busy: false, uncertain: false, conflict: false, error: null }));
  const search = idle.match(/<input[^>]*id="wiki-pane-query"[^>]*>/)?.[0] || '';
  assert.ok(search && !search.includes('disabled'));
  assert.ok(idle.match(/<button[^>]*class="wiki-pane-note"[^>]*>/)?.[0] && !idle.match(/<button[^>]*class="wiki-pane-note"[^>]*>/)[0].includes('disabled'));
  assert.ok(idle.match(/<button[^>]*class="wiki-pane-link"[^>]*>/)?.[0] && !idle.match(/<button[^>]*class="wiki-pane-link"[^>]*>/)[0].includes('disabled'));
  assert.equal(calls.length, 0, 'SSR must not invoke controller actions');
});
