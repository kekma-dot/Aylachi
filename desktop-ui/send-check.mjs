import assert from "node:assert/strict";
import { submitDraft } from "./send.mjs";
const card = { id: "card-1", sessionId: "session-1" };
const original = "  keep this text  ";
const failed = await submitDraft({ card, draft: original, onSend: async () => { throw new Error("SESSION_BUSY"); } });
assert.equal(failed.accepted, false);
assert.equal(failed.error, "SESSION_BUSY");
assert.equal(failed.nextDraft(original), original);
const submitted = await submitDraft({ card, draft: original, onSend: async payload => {
  assert.deepEqual(payload, { cardId: "card-1", sessionId: "session-1", text: "keep this text" });
  return { accepted: true };
} });
assert.equal(submitted.accepted, true);
assert.equal(submitted.nextDraft(original), "");
assert.equal(submitted.nextDraft("new text typed while pending"), "new text typed while pending");
console.log("send acceptance state OK");
