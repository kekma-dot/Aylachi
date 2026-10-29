export const MODEL_PROVIDER = 'openai-codex';
export const DEFAULT_MODEL_ID = 'gpt-6-luna';
export const DEFAULT_REASONING = 'low';
export const REASONING_LEVELS = Object.freeze(['low', 'medium', 'high']);

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

export function snapshotModelSelection(value, catalog) {
  if (!exact(value, ['provider', 'modelId', 'reasoning']) || !id(value.provider) || !id(value.modelId) ||
      !REASONING_LEVELS.includes(value.reasoning) || !catalog?.models?.some(model =>
        model.provider === value.provider && model.id === value.modelId)) throw new TypeError('MODEL_POLICY_REJECTED');
  return Object.freeze({ provider: value.provider, modelId: value.modelId, reasoning: value.reasoning });
}

export function snapshotModelCatalog(value, provider = MODEL_PROVIDER) {
  if (!id(provider)) throw new TypeError('INVALID_MODEL_CATALOG');
  if (!exact(value, ['models', 'default']) || !Array.isArray(value.models) || value.models.length < 1 || value.models.length > 100) {
    throw new TypeError('INVALID_MODEL_CATALOG');
  }
  const models = value.models.map(model => {
    if (!(exact(model, ['provider', 'id', 'name']) || exact(model, ['provider', 'id', 'name', 'contextWindow'])) ||
        model.provider !== provider || !id(model.id) || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 200 ||
        (Object.hasOwn(model, 'contextWindow') && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || model.contextWindow > 100_000_000))) throw new TypeError('INVALID_MODEL_CATALOG');
    return Object.freeze({ provider: model.provider, id: model.id, name: model.name, ...(Object.hasOwn(model, 'contextWindow') ? { contextWindow: model.contextWindow } : {}) });
  });
  if (new Set(models.map(model => model.id)).size !== models.length) throw new TypeError('INVALID_MODEL_CATALOG');
  const catalog = { models: Object.freeze(models), default: value.default };
  const selection = snapshotModelSelection(catalog.default, catalog);
  return Object.freeze({ models: catalog.models, default: selection });
}

export function modelPatch(selection) {
  return { modelProvider: selection.provider, modelId: selection.modelId, reasoning: selection.reasoning };
}

export function selectionFromCard(card, catalog) {
  if (card?.modelProvider === undefined) return catalog.default;
  return snapshotModelSelection({ provider: card.modelProvider, modelId: card.modelId, reasoning: card.reasoning }, catalog);
}
