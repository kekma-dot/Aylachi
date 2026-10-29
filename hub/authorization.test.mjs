import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "./authorization.mjs";
const grant = (effect, permission, operation, refs = {}) => ({ effect, permission, operation, ...refs });
const base = { principalId: "principal-a", expiresAt: 2_000, revoked: false, grants: [grant("allow", "read", "card.get", { projectId: "p1", cardId: "c1", sessionId: "s1" })] };
const req = { operation: "card.get", requestId: "req-1", projectId: "p1", cardId: "c1", sessionId: "s1" };
const descriptor = { operation: "card.get", effect: "read", projectId: "p1", cardId: "c1", sessionId: "s1" };
const auth = (context, input = req, resolved = descriptor, now = 1) => authorize(context, input, resolved, now);
test("deny beats allow", () => {
  const context = { ...base, grants: [...base.grants, grant("deny", "read", "card.get", { projectId: "p1" })] };
  assert.deepEqual(auth(context), { allowed: false, reason: "denied" });
});
test("payload identity cannot elevate", () => {
  assert.deepEqual(auth(base, { ...req, principalId: "admin", grants: [grant("allow", "write", "card.get")] }), { allowed: true, principalId: "principal-a", requestId: "req-1" });
});
test("foreign trusted project, card and session deny", () => {
  for (const changed of [{ projectId: "p2" }, { cardId: "c2" }, { sessionId: "s2" }]) assert.equal(auth(base, { ...req, ...changed }, { ...descriptor, ...changed }).allowed, false);
});
test("revoked and expired context deny", () => {
  assert.equal(auth({ ...base, revoked: true }).allowed, false);
  assert.equal(auth(base, req, descriptor, 2_000).allowed, false);
});
test("unknown permission and malformed input deny", () => {
  assert.equal(auth({ ...base, grants: [grant("allow", "admin", "card.get")] }).allowed, false);
  for (const input of [null, { ...req, operation: "bad space" }, { ...req, requestId: "" }, { ...req, effect: "execute" }]) assert.equal(auth(base, input).allowed, false);
});
test("delegated scope cannot exceed parent", () => {
  const delegated = { ...base, delegated: true, parentGrants: base.grants, grants: [grant("allow", "read", "card.get", { projectId: "p1" })] };
  assert.equal(auth(delegated).allowed, false);
  assert.equal(auth({ ...delegated, grants: base.grants }).allowed, true);
});
test("parent deny blocks delegated allow bypass", () => {
  const allow = grant("allow", "read", "card.get", { projectId: "p1" });
  const deny = grant("deny", "read", "card.get", { projectId: "p1" });
  assert.deepEqual(auth({ ...base, delegated: true, grants: [allow], parentGrants: [allow, deny] }), { allowed: false, reason: "delegation_exceeds_parent" });
});
test("trusted descriptor determines effect and target", () => {
  assert.equal(auth(base, { ...req, effect: "read" }, { ...descriptor, effect: "write" }).allowed, false);
  assert.equal(auth(base, req, { ...descriptor, effect: "write" }).allowed, false);
  assert.equal(auth(base, req, { ...descriptor, projectId: "foreign" }).allowed, false);
});
test("unknown grants and malformed context deny", () => {
  assert.equal(auth({ ...base, grants: [{ ...base.grants[0], surprise: true }] }).allowed, false);
  assert.equal(auth({ ...base, expiresAt: "later" }).allowed, false);
});
