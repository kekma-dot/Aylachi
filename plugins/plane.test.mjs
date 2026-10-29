import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginPlane } from './plane.mjs';

test('plugin compatibility is checked before activation and disable preserves core', async () => {
  const plane = createPluginPlane({ hostApiVersion: 5 });
  let activations = 0;
  assert.throws(() => plane.register({ id: 'old', version: '1', apiVersion: 4, owner: 'test', capabilities: ['tools'], activate() { activations++; } }), { code: 'INCOMPATIBLE_PLUGIN' });
  assert.equal(activations, 0);
  let disposed = 0;
  const core = { chat: true };
  plane.register({ id: 'optional', version: '1.0.0', apiVersion: 5, owner: 'test', capabilities: ['tools', 'events'],
    activate: ({ generation }) => { activations++; return { dispose: () => { disposed++; }, health: () => ({ state: generation === 1 ? 'READY' : 'DEGRADED' }) }; } });
  await plane.activate('optional');
  assert.equal((await plane.health('optional')).state, 'READY');
  await plane.disable('optional');
  assert.equal(core.chat, true);
  assert.equal(disposed, 1);
  assert.equal(plane.list()[0].status, 'DISABLED');
  await plane.shutdown();
});

test('disable fences late activation and stale resources cannot enter a new generation', async () => {
  const plane = createPluginPlane({ hostApiVersion: 5 });
  let start, disposed = 0, activations = 0;
  const pending = new Promise(resolve => { start = resolve; });
  plane.register({ id: 'slow', version: '1', apiVersion: 5, owner: 'test', capabilities: ['commands'],
    async activate() { activations++; await pending; return { dispose: () => { disposed++; } }; } });
  const activation = plane.activate('slow');
  const disabling = plane.disable('slow');
  start();
  assert.equal((await activation).activated, false);
  await disabling;
  assert.equal(disposed, 1);
  assert.equal(plane.list()[0].status, 'DISABLED');
  plane.register({ id: 'next', version: '1', apiVersion: 5, owner: 'test', capabilities: ['nodeViews'], activate: () => ({ health: () => ({ state: 'READY' }) }) });
  await plane.activate('next');
  assert.equal(plane.list().find(item => item.id === 'next').generation, 1);
  assert.equal(activations, 1);
  await plane.shutdown();
});
