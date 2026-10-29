import test from 'node:test';
import assert from 'node:assert/strict';
import { createWikiController } from './wiki-controller.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const id2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rev1 = '22222222-2222-4222-8222-222222222222';
const rev2 = '33333333-3333-4333-8333-333333333333';
const rev3 = '44444444-4444-4444-8444-444444444444';
const link = '55555555-5555-4555-8555-555555555555';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function client(overrides = {}) {
  return {
    search: async () => ({ notes: [] }),
    read: async noteId => ({ id: noteId, revision: rev1, content: 'original' }),
    create: async () => ({ id, revision: rev1 }),
    update: async () => ({ id, revision: rev2 }),
    history: async () => ({ revisions: [rev1, rev2] }),
    diff: async () => ({ changes: [{ start: 0, remove: ['original'], insert: ['edited'] }] }),
    restore: async () => ({ id, revision: rev3 }),
    links: async () => ({ links: [link] }),
    ...overrides,
  };
}

test('create, read, update, history, compare and restore use UUID revisions and client signatures', async () => {
  const calls = [];
  const c = client({
    search: async (query, options) => { calls.push(['search', query, options.signal]); return { notes: [{ id, revision: rev1 }] }; },
    read: async (noteId, options = {}) => { calls.push(['read', noteId, options]); return { id: noteId, revision: options.revision ?? rev1, content: options.revision === rev1 ? 'original' : 'original' }; },
    update: async (noteId, options) => { calls.push(['update', noteId, options]); return { id: noteId, revision: rev2 }; },
    history: async (noteId, options) => { calls.push(['history', noteId, options.signal]); return { revisions: [rev1, rev2] }; },
    diff: async (noteId, options) => { calls.push(['diff', noteId, options]); return { changes: [{ start: 0, remove: ['original'], insert: ['edited'] }] }; },
    restore: async (noteId, options) => { calls.push(['restore', noteId, options]); return { id: noteId, revision: rev3 }; },
  });
  const controller = createWikiController({ client: c });
  assert.equal(await controller.search('needle'), true);
  assert.deepEqual(controller.getSnapshot().notes, [{ id, revision: rev1 }]);
  assert.equal(await controller.openNote(id), true);
  assert.deepEqual(controller.getSnapshot().selected, { id, revision: rev1, content: 'original' });
  assert.deepEqual(controller.getSnapshot().links, [link]);
  assert.equal(controller.edit('edited'), true);
  assert.equal(await controller.save(), true);
  assert.deepEqual(controller.getSnapshot().selected, { id, revision: rev2, content: 'edited' });
  assert.equal(calls.find(call => call[0] === 'update')[2].expectedRevision, rev1);
  assert.equal(await controller.loadHistory(), true);
  assert.deepEqual(controller.getSnapshot().history, [rev1, rev2]);
  assert.equal(await controller.compare(rev1, rev2), true);
  assert.equal(controller.getSnapshot().changes[0].insert[0], 'edited');
  assert.equal(await controller.restore(rev1), true);
  assert.deepEqual(controller.getSnapshot().selected, { id, revision: rev3, content: 'original' });
  assert.equal(calls.find(call => call[0] === 'restore')[2].expectedRevision, rev2);
  assert.equal(calls.find(call => call[0] === 'read' && call[2].revision)?.[2].revision, rev1);
  controller.dispose();
});

test('create save stores the returned UUID; 409 preserves draft and base revision until explicit reconcile', async () => {
  let creates = 0, updates = 0, reads = 0;
  const controller = createWikiController({ client: client({
    create: async ({ content }) => { creates++; assert.equal(content, 'new note'); return { id: id2, revision: rev1 }; },
    update: async (noteId, options) => { updates++; assert.equal(noteId, id); if (updates === 1) { assert.equal(options.expectedRevision, rev1); throw Object.assign(Error(), { status: 409, code: 'HTTP_ERROR' }); } assert.equal(options.expectedRevision, rev2); return { id, revision: rev3 }; },
    read: async noteId => (++reads === 1 ? { id: noteId, revision: rev1, content: 'original' } : { id: noteId, revision: rev2, content: 'remote' }),
  }) });
  controller.edit('new note');
  assert.equal(await controller.save(), true);
  assert.equal(controller.getSnapshot().selected.id, id2);
  controller.newNote();
  await controller.openNote(id);
  controller.edit('my draft');
  assert.equal(await controller.save(), false);
  let state = controller.getSnapshot();
  assert.equal(state.selected.revision, rev1);
  assert.equal(state.draft, 'my draft'); assert.equal(state.dirty, true); assert.equal(state.conflict, true);
  assert.equal(await controller.save(), false); assert.equal(updates, 1);
  assert.equal(await controller.reconcile(), true);
  state = controller.getSnapshot();
  assert.equal(state.selected.revision, rev2); assert.equal(state.selected.content, 'remote');
  assert.equal(state.draft, 'my draft'); assert.equal(state.dirty, true); assert.equal(state.conflict, false);
  assert.equal(await controller.save(), true); assert.equal(updates, 2);
  assert.equal(controller.getSnapshot().selected.revision, rev3);
  assert.equal(creates, 1);
  controller.dispose();
});

test('unknown create never retries or invents an ID; uncertainty survives discard, switch, and reconcile attempts', async () => {
  let creates = 0, reads = 0, searches = 0;
  const controller = createWikiController({ client: client({
    create: async () => { creates++; throw Object.assign(Error(), { unknownOutcome: true, code: 'CONNECTION_FAILED' }); },
    read: async (...args) => { reads++; return client().read(...args); },
    search: async () => { searches++; return { notes: [] }; },
  }) });
  controller.edit('possibly-created');
  assert.equal(await controller.save(), false);
  assert.equal(controller.getSnapshot().selected, null);
  assert.equal(controller.getSnapshot().uncertain, true);
  assert.equal(controller.getSnapshot().error, 'OUTCOME_UNKNOWN');
  assert.equal(await controller.save(), false);
  assert.equal(controller.newNote({ discard: true }), false);
  assert.equal(await controller.openNote(id, { discard: true }), false);
  assert.equal(await controller.reconcile(), false);
  assert.equal(controller.edit('changed'), false);
  assert.equal(creates, 1); assert.equal(reads, 0); assert.equal(searches, 0);
  assert.equal(controller.getSnapshot().draft, 'possibly-created');
  controller.dispose();
});

test('unknown update reconciliation refreshes server revision without clearing uncertainty or draft', async () => {
  let updates = 0, reads = 0;
  const controller = createWikiController({ client: client({
    update: async () => { updates++; throw Object.assign(Error(), { unknownOutcome: true, code: 'CONNECTION_FAILED' }); },
    read: async noteId => { reads++; return reads === 1 ? { id: noteId, revision: rev1, content: 'original' } : { id: noteId, revision: rev2, content: 'draft' }; },
  }) });
  await controller.openNote(id);
  controller.edit('draft');
  assert.equal(await controller.save(), false);
  assert.equal(await controller.reconcile(), true);
  const state = controller.getSnapshot();
  assert.equal(state.selected.revision, rev2);
  assert.equal(state.draft, 'draft'); assert.equal(state.dirty, true); assert.equal(state.uncertain, true);
  assert.equal(state.error, 'OUTCOME_UNKNOWN');
  assert.equal(await controller.save(), false);
  assert.equal(reads, 2); assert.equal(updates, 1);
  controller.dispose();
});

test('reconcile adopts authoritative content only when the draft is clean', async () => {
  let note = { id, revision: rev1, content: 'old' };
  const controller = createWikiController({ client: client({
    read: async noteId => ({ ...note, id: noteId }),
    history: async () => ({ revisions: [rev1, rev2, rev3] }),
  }) });
  await controller.openNote(id);
  note = { id, revision: rev2, content: 'external update' };
  assert.equal(await controller.reconcile(), true);
  let state = controller.getSnapshot();
  assert.equal(state.selected.content, 'external update');
  assert.equal(state.draft, 'external update'); assert.equal(state.dirty, false);

  controller.edit('local draft');
  note = { id, revision: rev3, content: 'another external update' };
  assert.equal(await controller.reconcile(), true);
  state = controller.getSnapshot();
  assert.equal(state.selected.content, 'another external update');
  assert.equal(state.draft, 'local draft'); assert.equal(state.dirty, true);
  controller.dispose();
});

test('update receipt for a different UUID is uncertain and preserves the original draft', async () => {
  let updates = 0;
  const controller = createWikiController({ client: client({
    update: async () => { updates++; return { id: id2, revision: rev2 }; },
  }) });
  await controller.openNote(id);
  controller.edit('must remain');
  assert.equal(await controller.save(), false);
  const state = controller.getSnapshot();
  assert.deepEqual(state.selected, { id, revision: rev1, content: 'original' });
  assert.equal(state.draft, 'must remain'); assert.equal(state.dirty, true);
  assert.equal(state.uncertain, true); assert.equal(state.error, 'OUTCOME_UNKNOWN');
  assert.equal(await controller.save(), false);
  assert.equal(updates, 1);
  controller.dispose();
});

test('dirty note switch/new note require explicit discard', async () => {
  const readIds = [];
  const controller = createWikiController({ client: client({ read: async noteId => { readIds.push(noteId); return { id: noteId, revision: rev1, content: `content:${noteId}` }; } }) });
  await controller.openNote(id);
  controller.edit('unsaved');
  assert.equal(await controller.openNote(id2), false);
  assert.equal(controller.newNote(), false);
  assert.deepEqual(readIds, [id]);
  assert.equal(controller.getSnapshot().selected.id, id);
  assert.equal(controller.getSnapshot().draft, 'unsaved');
  assert.equal(await controller.openNote(id2, { discard: true }), true);
  assert.equal(controller.getSnapshot().selected.id, id2);
  controller.edit('again');
  assert.equal(controller.newNote({ discard: true }), true);
  assert.equal(controller.getSnapshot().selected, null); assert.equal(controller.getSnapshot().draft, '');
  controller.dispose();
});

test('edit is rejected while busy; disposal aborts reads and ignores late completion', async () => {
  const pending = deferred();
  let signal, notices = 0;
  const controller = createWikiController({ client: client({ search: (_query, options) => { signal = options.signal; return pending.promise; } }) });
  controller.subscribe(() => notices++);
  const request = controller.search('slow');
  const beforeDispose = controller.getSnapshot();
  assert.equal(controller.edit('must not overwrite'), false);
  assert.equal(controller.getSnapshot().draft, '');
  controller.dispose();
  assert.equal(signal.aborted, true);
  const afterDispose = controller.getSnapshot();
  pending.resolve({ notes: [{ id, revision: rev1 }] });
  assert.equal(await request, false);
  assert.equal(controller.getSnapshot(), afterDispose);
  assert.equal(notices, 1);
  assert.equal(beforeDispose.busy, true);
});

test('disposal does not abort a mutation and stale receipt cannot update the disposed view', async () => {
  const pending = deferred();
  let signal, notices = 0;
  const controller = createWikiController({ client: client({ create: options => { signal = options.signal; return pending.promise; } }) });
  controller.subscribe(() => notices++);
  controller.edit('pending create');
  const request = controller.save();
  const beforeDispose = controller.getSnapshot();
  controller.dispose();
  assert.equal(signal.aborted, false);
  const afterDispose = controller.getSnapshot();
  pending.resolve({ id, revision: rev1 });
  assert.equal(await request, false);
  assert.equal(controller.getSnapshot(), afterDispose);
  assert.equal(notices, 2);
  assert.equal(beforeDispose.busy, true);
});
