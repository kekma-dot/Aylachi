import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from './server.mjs';

const base = ['--state-root', '/synthetic/aylachi-state'];
const live = [...base, '--allow-live', '--sdk-root', '/synthetic/sdk'];

test('delegation CLI is explicit, bounded and disabled in legacy/model-off/bootstrap paths', () => {
  assert.equal(Object.hasOwn(parseArgs(base), 'delegation'), false);
  assert.equal(Object.hasOwn(parseArgs(live), 'delegation'), false);
  const args = parseArgs([...live, '--delegate-session', 'session-a', '--delegate-session', 'session-b']);
  assert.deepEqual(args.delegation.parentSessionIds, ['session-a', 'session-b']);
  assert.ok(Object.isFrozen(args.delegation));
  assert.ok(Object.isFrozen(args.delegation.parentSessionIds));
  assert.throws(() => parseArgs([...base, '--delegate-session', 'session-a']), error => error.code === 'LIVE_FLAGS_INVALID');
  assert.throws(() => parseArgs([...live, '--bootstrap', '--delegate-session', 'session-a']), error => error.code === 'INVALID_ARGUMENTS');
  for (const sessions of [['session-a', 'session-a'], ['../bad'], ['a', 'b', 'c', 'd'], ['']]) {
    assert.throws(() => parseArgs([...live, ...sessions.flatMap(id => ['--delegate-session', id])]));
  }
  assert.throws(() => parseArgs([...live, '--delegate-session']), error => error.code === 'INVALID_ARGUMENTS');
  assert.throws(() => parseArgs([...live, '--delegate-session', '--help']), error => error.code === 'INVALID_ARGUMENTS');
  assert.equal(parseArgs(['--help']).help, true);
});
