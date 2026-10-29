const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CARD_KEYS = ['id', 'canvasId', 'sessionId', 'title', 'x', 'y', 'revision'];
const CARD_OPTIONAL_KEYS = ['width', 'height', 'modelProvider', 'modelId', 'reasoning'];
const MAX_CARDS = 100;
const mappingFailure = code => Object.assign(new Error(code), { code });

function validateMapping(cards, canvasId) {
  const cardIds = new Set();
  const sessionIds = new Set();
  for (const card of cards) {
    if (!card || typeof card !== 'object' || Array.isArray(card) ||
        ![CARD_KEYS.length, CARD_KEYS.length + 2, CARD_KEYS.length + 3, CARD_KEYS.length + CARD_OPTIONAL_KEYS.length].includes(Object.keys(card).length) ||
        [...CARD_KEYS, ...CARD_OPTIONAL_KEYS].some(key => !Object.hasOwn(card, key) && CARD_KEYS.includes(key)) ||
        Object.keys(card).some(key => ![...CARD_KEYS, ...CARD_OPTIONAL_KEYS].includes(key)) ||
        (Object.hasOwn(card, 'width') !== Object.hasOwn(card, 'height')) ||
        (['modelProvider', 'modelId', 'reasoning'].some(key => Object.hasOwn(card, key)) !== Object.hasOwn(card, 'modelProvider'))) {
      throw mappingFailure('INVALID_CATALOG');
    }
    if (typeof card.id !== 'string' || !ID.test(card.id) ||
        typeof card.sessionId !== 'string' || !ID.test(card.sessionId) ||
        typeof card.canvasId !== 'string' || !ID.test(card.canvasId) || card.canvasId !== canvasId ||
        cardIds.has(card.id) || sessionIds.has(card.sessionId)) {
      throw mappingFailure('INVALID_SESSION_MAPPING');
    }
    if (typeof card.title !== 'string' || card.title.length < 1 || card.title.length > 4096 ||
        !Number.isFinite(card.x) || !Number.isFinite(card.y) ||
        !Number.isSafeInteger(card.revision) || card.revision < 1 ||
        (Object.hasOwn(card, 'width') && (!Number.isFinite(card.width) || !Number.isFinite(card.height) ||
          card.width < 320 || card.width > 1200 || card.height < 360 || card.height > 1200)) ||
        (Object.hasOwn(card, 'modelProvider') && (!ID.test(card.modelProvider) || !ID.test(card.modelId) || !['low', 'medium', 'high'].includes(card.reasoning)))) {
      throw mappingFailure('INVALID_CATALOG');
    }
    cardIds.add(card.id);
    sessionIds.add(card.sessionId);
  }
}

// Canonical L05 catalog semantics, unchanged: bounded, well-formed, additive only.
export function validateCatalog(result, canvasId, previousCards = null) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).length !== 1 || !Object.hasOwn(result, 'cards') ||
      !Array.isArray(result.cards) || result.cards.length > MAX_CARDS) throw mappingFailure('INVALID_CATALOG');
  const cards = result.cards;
  if (cards.length === 0 && previousCards?.length) throw mappingFailure('INVALID_CATALOG');
  validateMapping(cards, canvasId);
  if (previousCards?.length) {
    const byId = new Map(cards.map(card => [card.id, card]));
    for (const previous of previousCards) {
      const next = byId.get(previous.id);
      if (!next || next.sessionId !== previous.sessionId || next.canvasId !== previous.canvasId) {
        throw mappingFailure('NON_ADDITIVE_CATALOG');
      }
    }
  }
  return cards;
}

// Immutable identity only: a legitimately renamed/moved card (title/x/y/revision)
// still resolves the intent; only card/canvas/session identity is matched.
// Freshness guard for catalog reads: only the latest begun read may publish
// or report an error. A delayed older response (success or failure) must not
// roll back a newer authoritative catalog (parent Chromium race FAIL5/6:
// stale refresh snapshot overwrote the accepted two-card catalog).
export function createCatalogReads() {
  let latest = 0;
  return {
    begin() { latest += 1; return latest; },
    fresh(ticket) { return ticket === latest; },
  };
}

export function matchesIntentIdentity(card, payload) {
  return card.id === payload.id && card.canvasId === payload.canvasId && card.sessionId === payload.sessionId;
}

const invalidReceipt = () => Object.assign(new Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE', unknownOutcome: true });

// The create receipt is the direct POST acknowledgement: it must echo the exact
// immutable intent payload, carry a duplicate boolean, and pass full card validation.
export function validateCreateReceipt(result, intent) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).length !== 2 || !Object.hasOwn(result, 'card') || !Object.hasOwn(result, 'duplicate') ||
      typeof result.duplicate !== 'boolean') throw invalidReceipt();
  const card = result.card;
  if (!card || typeof card !== 'object' || Array.isArray(card) ||
      Object.keys(card).length !== CARD_KEYS.length || CARD_KEYS.some(key => !Object.hasOwn(card, key))) throw invalidReceipt();
  if (!matchesIntentIdentity(card, intent.payload) ||
      card.title !== intent.payload.title || card.x !== intent.payload.x || card.y !== intent.payload.y) throw invalidReceipt();
  try {
    validateMapping([card], intent.canvasId);
  } catch {
    throw invalidReceipt();
  }
  return card;
}

// Stable distinct card/session/request IDs, immutable payload; first card lands
// on the empty canvas at a fixed position, later cards offset deterministically.
export function createIntent(context, cards, usedIds) {
  const used = new Set(usedIds);
  for (const card of cards) {
    used.add(card.id);
    used.add(card.sessionId);
  }
  const makeId = () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const value = globalThis.crypto?.randomUUID?.();
      if (typeof value === 'string' && ID.test(value) && !used.has(value)) {
        used.add(value);
        usedIds.add(value);
        return value;
      }
    }
    throw mappingFailure('ID_GENERATION_FAILED');
  };
  const column = cards.length % 3;
  const row = Math.floor(cards.length / 3);
  const payload = Object.freeze({
    id: makeId(),
    canvasId: context.canvasId,
    sessionId: makeId(),
    title: 'New chat',
    x: 80 + column * 520,
    y: 80 + row * 560,
  });
  return Object.freeze({
    client: context.client,
    canvasId: context.canvasId,
    generation: context.generation,
    payload,
    requestId: makeId(),
  });
}


export { MAX_CARDS, mappingFailure };
