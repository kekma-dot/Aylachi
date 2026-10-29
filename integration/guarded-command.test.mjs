import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorize } from '../hub/authorization.mjs';
import { openStore } from '../persistence/store.mjs';

// A test-only dispatcher: proves boundary composition, not transport authentication or a sandbox.
test('authorized command executes once; reconnect and uncertain recovery never replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'aylachi-command-'));
  let store;
  try {
    const database = join(root, 'state.sqlite');
    const effect = join(root, 'effect.txt');
    store = openStore(database);
    const card = { id: 'card', canvasId: 'canvas', sessionId: 'session', title: 'test', x: 0, y: 0 };
    store.createCard(card);
    const descriptor = { operation: 'fixture.mark', effect: 'write', projectId: 'project', cardId: card.id, sessionId: card.sessionId };
    const grant = { effect: 'allow', permission: 'write', operation: descriptor.operation, projectId: descriptor.projectId, cardId: card.id, sessionId: card.sessionId };
    const context = { principalId: 'owner', expiresAt: 2000, revoked: false, grants: [grant] };
    const request = { operation: descriptor.operation, requestId: 'command', cardId: card.id };
    const dispatch = (ctx, req, finish = true) => {
      const decision = authorize(ctx, req, descriptor, 1);
      assert.equal(decision.allowed, true, decision.reason);
      const receipt = store.reserveCommand({ id: req.requestId, cardId: card.id, input: { operation: descriptor.operation, sessionId: card.sessionId } });
      if (!receipt.created) return receipt.command;
      let prior = '';
      try { prior = readFileSync(effect, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      writeFileSync(effect, prior + 'effect\n');
      return finish ? store.completeCommand(req.requestId, { ok: true }) : receipt.command;
    };
    assert.equal(dispatch(context, request).state, 'COMPLETED');
    assert.equal(dispatch(context, request).state, 'COMPLETED');
    assert.equal(readFileSync(effect, 'utf8'), 'effect\n');
    store.close();
    store = openStore(database);
    assert.equal(dispatch(context, request).state, 'COMPLETED');
    assert.equal(readFileSync(effect, 'utf8'), 'effect\n');

    const eventsBefore = store.getEvents().length;
    assert.throws(() => dispatch({ ...context, revoked: true }, { ...request, requestId: 'denied' }), /false !== true/);
    assert.equal(store.getCommand('denied'), undefined);
    assert.equal(store.getEvents().length, eventsBefore);
    assert.equal(authorize(context, { ...request, projectId: 'foreign', requestId: 'foreign' }, descriptor, 1).allowed, false);

    const uncertain = { ...request, requestId: 'uncertain' };
    dispatch(context, uncertain, false); // effect happened, completion was never recorded
    store.close();
    store = openStore(database);
    assert.equal(store.recoverInterrupted(), 1);
    assert.equal(dispatch(context, uncertain).state, 'NEEDS_RECONCILIATION');
    assert.equal(readFileSync(effect, 'utf8'), 'effect\neffect\n');
    assert.equal(store.getCard(card.id).sessionId, card.sessionId);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
