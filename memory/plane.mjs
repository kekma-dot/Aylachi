const bad = (code, status = 400) => Object.assign(new Error(code), { code, status });

export function createMemoryPlane({ store, promotionPolicy, applyPromotion } = {}) {
  if (!store || (promotionPolicy !== undefined && typeof promotionPolicy !== 'function') ||
      (applyPromotion !== undefined && typeof applyPromotion !== 'function')) throw new TypeError('memory store and trusted promotion functions required');
  return Object.freeze({
    async promote(id) {
      if (!promotionPolicy || !applyPromotion) throw bad('MEMORY_PROMOTION_UNAVAILABLE', 409);
      const current = store.get(id);
      if (!current) throw bad('MEMORY_PROPOSAL_NOT_FOUND', 404);
      if (current.state !== 'APPROVED') throw bad('MEMORY_PROMOTION_NOT_APPROVED', 409);
      // Policy denial has no external effect and must remain retryable.
      const decision = await promotionPolicy({ proposal: current });
      if (!decision || decision.allow !== true || typeof decision.ticket !== 'string') throw bad('MEMORY_PROMOTION_DENIED', 409);
      const started = store.beginPromotion(id);
      if (started.conflict) return started;
      try {
        const receipt = await applyPromotion({ proposal: started.proposal, ticket: decision.ticket });
        return { proposal: store.completePromotion(id, decision.ticket, receipt), conflict: false };
      } catch (error) {
        store.unknownPromotion(id);
        throw error;
      }
    },
    recover() { return store.recoverPromotions(); },
  });
}
