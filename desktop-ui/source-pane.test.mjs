import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let SourcePane;
before(async () => {
  vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  ({ default: SourcePane } = await vite.ssrLoadModule('/SourcePane.jsx'));
});
after(async () => {
  if (!vite) return;
  try { await vite.waitForRequestsIdle(); }
  finally { await vite.close(); }
});

const render = (state = {}, actions = {}) => renderToStaticMarkup(React.createElement(SourcePane, { state, actions }));
  const selected = { id: 'file-1', path: 'src/<unsafe>.js', content: 'const value = "<script>";', sha256: 'saved-hash', baselineSha256: 'base-hash' };
  const actions = { refresh() {}, selectFile() {}, edit() {}, save() {}, reconcile() {}, discardDraft() {}, loadDiff() {} };

  test('empty and selected views escape content and stay inside the pane landmark', () => {
    const empty = render();
    assert.match(empty, /aria-label="Source workbench"/);
    assert.match(empty, /No source files/);
    assert.equal((empty.match(/<main(?:\s|>)/g) ?? []).length, 0);
    assert.doesNotMatch(empty, /Theme: /);
    const html = render({ files: [{ ...selected }], selected, draft: selected.content }, actions);
    assert.match(html, /src\/&lt;unsafe&gt;\.js/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /saved-hash/);
    assert.match(html, /base-hash/);
    assert.doesNotMatch(html, /<script>/);
  });

  test('errors are escaped; render invokes no actions and exposes no execution controls', () => {
    const calls = [];
    const html = render({ selected, error: '<img src=x onerror=alert(1)>', draft: selected.content },
      Object.fromEntries(Object.keys(actions).map(key => [key, (...args) => calls.push([key, args])] )));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.deepEqual(calls, []);
    assert.doesNotMatch(html, />Run</);
    assert.doesNotMatch(html, />Check</);
    assert.doesNotMatch(html, /shell/i);
  });

  test('busy, dirty, conflict, and unknown states lock the specified controls', () => {
    const buttons = html => [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)].map(([, attrs, text]) => ({ attrs, text }));
    const control = (list, label) => {
      const matches = list.filter(button => button.text.trim() === label || button.attrs.includes(`aria-label="${label}"`));
      assert.equal(matches.length, 1, `expected exactly one button for ${label}`);
      return matches[0];
    };
    const disabled = (list, label) => assert.match(control(list, label).attrs, /disabled/);
    const plainSelected = { ...selected, path: 'src/sample.js' };
    const busy = buttons(render({ selected: plainSelected, files: [plainSelected], busy: true, dirty: true, draft: 'keep busy' }, actions));
    for (const label of ['Refresh files', 'Open source file src/sample.js', 'Discard draft', 'Save', 'Load saved diff']) disabled(busy, label);
    assert.match(render({ selected: plainSelected, files: [plainSelected], busy: true, dirty: true, draft: 'keep busy' }, actions), /keep busy/);
    assert.match(render({ selected, busy: true, draft: selected.content }, actions), /id="source-pane-editor"[^>]*disabled=""/);
    const dirty = buttons(render({ selected: plainSelected, files: [plainSelected], dirty: true, draft: 'draft' }, actions));
    disabled(dirty, 'Refresh files'); disabled(dirty, 'Open source file src/sample.js'); disabled(dirty, 'Load saved diff');
    assert.doesNotMatch(control(dirty, 'Discard draft').attrs, /disabled/);
    assert.doesNotMatch(control(dirty, 'Save').attrs, /disabled/);
    const conflictState = { selected: plainSelected, files: [plainSelected], conflict: true, dirty: true, draft: 'keep me' };
    const conflict = buttons(render(conflictState, actions));
    disabled(conflict, 'Save'); disabled(conflict, 'Refresh files'); disabled(conflict, 'Open source file src/sample.js');
    assert.match(render(conflictState, actions), /keep me/);
    const unknownState = { selected: plainSelected, files: [plainSelected], uncertain: true, dirty: true, draft: 'keep me' };
    const unknown = buttons(render(unknownState, actions));
    disabled(unknown, 'Save'); disabled(unknown, 'Discard draft');
    assert.match(render(unknownState, actions), /keep me/);
    assert.match(render({ selected, uncertain: true, draft: selected.content }, actions), /id="source-pane-editor"[^>]*disabled=""/);
  });

  test('only matching saved baseline diff is current; wrong-file and stale diff are marked unavailable', () => {
    const diff = { id: selected.id, fromSha256: selected.baselineSha256, toSha256: selected.sha256, changes: [{ start: 0, remove: ['old'], insert: ['new'] }] };
    assert.match(render({ selected, diff }), /Saved baseline diff/);
    assert.match(render({ selected, diff }), /old/);
    const wrongFile = render({ selected, diff: { ...diff, id: 'other' } });
    assert.match(wrongFile, /stale or belongs to another file/);
    assert.doesNotMatch(wrongFile, /<del>old<\/del>/);
    const stale = render({ selected: { ...selected, sha256: 'newer' }, diff });
    assert.match(stale, /stale or belongs to another file/);
    const dirty = render({ selected, diff, dirty: true, draft: 'unsaved edit' });
    assert.match(dirty, /stale or belongs to another file/);
    assert.doesNotMatch(dirty, /<del>old<\/del>/);
  });
