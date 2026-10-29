import assert from 'node:assert/strict';
import test from 'node:test';
import { withNativeSkillResources } from './native-skills-resources.mjs';

test('selected native skill metadata needs fresh own-session turn and preserves loader lifecycle', async () => {
  let turn;
  class Loader {
    #reloads = 0;
    async reload() { this.#reloads++; }
    getExtensions() { return { reloads: this.#reloads }; }
    getSkills() { throw Error('ambient skills must not be consulted'); }
  }
  const original = new Loader();
  const selected = Object.freeze([Object.freeze({ name: 'fixture' })]);
  const loader = withNativeSkillResources(original, selected, { sessionId: 'alpha', getTurnContext: () => turn });
  assert.deepEqual(loader.getSkills().skills, []);
  turn = Object.freeze({ sessionId: 'beta', turnId: 'other' });
  assert.deepEqual(loader.getSkills().skills, []);
  turn = { sessionId: 'alpha', turnId: 'mutable' };
  assert.deepEqual(loader.getSkills().skills, []);
  turn = Object.freeze({ sessionId: 'alpha', turnId: 'own' });
  assert.strictEqual(loader.getSkills().skills, selected);
  await loader.reload();
  assert.deepEqual(loader.getExtensions(), { reloads: 1 });
  turn = undefined;
  assert.deepEqual(loader.getSkills().skills, []);
  assert.strictEqual(withNativeSkillResources(original, [], { sessionId: 'beta', getTurnContext: () => turn }), original);
});
