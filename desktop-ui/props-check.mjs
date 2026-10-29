import assert from "node:assert/strict";
const cards = [
  { id: "a", canvasId: "c", sessionId: "s1", title: "A", x: 1, y: 2, revision: 1 },
  { id: "b", canvasId: "c", sessionId: "s2", title: "B", x: 3, y: 4, revision: 1 },
];
const messagesBySession = { s1: [{ id: "m1", text: "private a" }], s2: [{ id: "m2", text: "private b" }] };
const cardMessages = card => messagesBySession[card.sessionId] || [];
assert.equal(cardMessages(cards[0])[0].text, "private a");
assert.equal(cardMessages(cards[1])[0].text, "private b");
assert.notEqual(cardMessages(cards[0]), cardMessages(cards[1]));
assert.equal(cards.length, 2);
console.log("props isolation OK (not an agent/runtime test)");
