export async function submitDraft({ card, draft, onSend }) {
  try {
    const receipt = await onSend({ cardId: card.id, sessionId: card.sessionId, text: draft.trim() });
    if (!receipt || receipt.accepted !== true) throw new Error(receipt?.message || "Message was not accepted");
    return { accepted: true, nextDraft: current => current === draft ? "" : current };
  } catch (error) {
    return { accepted: false, nextDraft: current => current, error: error?.message || "Message could not be sent" };
  }
}
