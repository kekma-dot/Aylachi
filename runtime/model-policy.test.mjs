import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MODEL_ID, DEFAULT_REASONING, MODEL_PROVIDER, modelPatch, snapshotModelCatalog, snapshotModelSelection } from './model-policy.mjs';

const models = [
  { provider: MODEL_PROVIDER, id: DEFAULT_MODEL_ID, name: 'Luna', contextWindow: 272000 },
  { provider: MODEL_PROVIDER, id: 'gpt-reasoning-next', name: 'Reasoning Next' },
];
const catalog = snapshotModelCatalog({ models, default: { provider: MODEL_PROVIDER, modelId: DEFAULT_MODEL_ID, reasoning: DEFAULT_REASONING } });

test('model catalog accepts only bounded physical models and an existing default', () => {
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].contextWindow, 272000);
  assert.deepEqual(snapshotModelSelection({ provider: MODEL_PROVIDER, modelId: 'gpt-reasoning-next', reasoning: 'high' }, catalog),
    { provider: MODEL_PROVIDER, modelId: 'gpt-reasoning-next', reasoning: 'high' });
  assert.throws(() => snapshotModelCatalog({ models: [...models, models[0]], default: catalog.default }), /INVALID_MODEL_CATALOG/);
  assert.throws(() => snapshotModelCatalog({ models: [{ provider: 'other', id: 'other', name: 'Other' }], default: catalog.default }), /INVALID_MODEL_CATALOG/);
});

test('wire selection maps to the exact durable model patch keys', () => {
  assert.deepEqual(modelPatch({ provider: MODEL_PROVIDER, modelId: 'gpt-reasoning-next', reasoning: 'high' }),
    { modelProvider: MODEL_PROVIDER, modelId: 'gpt-reasoning-next', reasoning: 'high' });
});

test('arbitrary providers, model IDs, reasoning levels and extra fields are rejected', () => {
  for (const selection of [
    { provider: 'other', modelId: DEFAULT_MODEL_ID, reasoning: 'low' },
    { provider: MODEL_PROVIDER, modelId: 'not-in-catalog', reasoning: 'low' },
    { provider: MODEL_PROVIDER, modelId: DEFAULT_MODEL_ID, reasoning: 'xhigh' },
    { ...catalog.default, sdkRoot: '/forbidden' },
  ]) assert.throws(() => snapshotModelSelection(selection, catalog), /MODEL_POLICY_REJECTED/);
});
