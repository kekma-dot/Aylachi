import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let HandoffPane;
before(async () => {
  vite = await createServer({
    configFile: new URL("./vite.config.js", import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
  });
  ({ default: HandoffPane } = await vite.ssrLoadModule("/HandoffPane.jsx"));
});
after(async () => { await vite?.close(); });

const revision = "22222222-2222-4222-8222-222222222222";
const noteId = "11111111-1111-4111-8111-111111111111";
const handoffId = "33333333-3333-4333-8333-333333333333";
const digest = "a".repeat(64);
const source = { cardId: "card-source", kind: "wiki", id: noteId, revision };
const wikiSelection = { kind: "wiki", id: noteId, revision };
const cards = [{ id: "card-source", title: "Source card" }, { id: "card-target", title: "Target card" }];
const snapshotText = "<script>never execute</script>\nVisible immutable text";
const record = (state = "pending") => ({
  id: handoffId, requestId: "proposal-7", state, source, targetCardId: "card-target",
  snapshot: { text: snapshotText, sha256: digest },
});
const calls = [];
const actions = Object.fromEntries(["propose", "refresh", "open", "accept", "reconcile", "retrySameRequest"]
  .map(name => [name, (...args) => calls.push([name, ...args])]));
function state(overrides = {}) {
  const selected = record();
  return {
    items: [{ id: selected.id, state: selected.state, source: selected.source, targetCardId: selected.targetCardId, snapshot: { sha256: digest } }],
    selected, busy: false, error: null, uncertain: false, pending: null, targetCardId: "card-target",
    ...overrides,
  };
}
function render(current = state(), selection = wikiSelection, selectionVersion = 0) {
  return renderToStaticMarkup(React.createElement(HandoffPane, { cards, state: current, actions, selection, selectionVersion }));
}
function button(html, label) {
  return html.match(new RegExp(`<button[^>]*>${label}<\\/button>`))?.[0] ?? "";
}

test("SSR renders explicit source/target form and safe immutable preview without actions", () => {
  calls.length = 0;
  const html = render();
  for (const label of ["Source card", "Source kind", "Wiki note ID", "Wiki revision (UUID)", "Target card", "Send transfer", "Incoming handoffs", "Refresh inbox", "Preview", "Immutable snapshot text"]) {
    assert.ok(html.includes(label), `missing ${label}`);
  }
  assert.ok(html.includes(`value="${revision}"`));
  assert.ok(html.includes(`value="${noteId}"`));
  assert.ok(html.includes(`value="${record().targetCardId}"`));
  const sourceCardField = html.match(/<select id="handoff-R0-source-card"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
  assert.match(sourceCardField, /<option value=""[^>]*>Choose source card<\/option>/);
  assert.ok(!sourceCardField.includes('value="card-source" selected=""'), "Wiki prefill must not choose a source card");
  assert.ok(button(html, "Send transfer").includes('disabled=""'), "Wiki prefill requires explicit source-card choice");
  const revisionField = html.match(/<input id=\"[^\"]*-revision\"[^>]*>/)?.[0] ?? "";
  assert.ok(revisionField.includes("required=\"\""), "Wiki revision must be required");
  assert.ok(html.includes(`SHA-256 ${digest}`));
  assert.ok(html.includes("Source ID") && html.includes(noteId));
  assert.ok(html.includes("Wiki revision"));
  assert.ok(html.includes("&lt;script&gt;never execute&lt;/script&gt;"));
  assert.ok(!html.includes("<script>never execute</script>"));
  assert.equal(calls.length, 0, "render must not call propose/refresh/open/accept/reconcile/retry");
});

test("command selection has no revision field; Wiki selection pre-fills only the local form", () => {
  const command = { cardId: "card-source", kind: "command", id: "command-42" };
  const html = render(state({ selected: null, items: [] }), command);
  assert.ok(html.includes("Command ID"));
  assert.ok(html.includes("value=\"command-42\""));
  assert.ok(html.includes('value="card-source" selected=""'), "command source card must be a known explicit card");
  assert.ok(!html.includes("Wiki revision (UUID)"));
  assert.equal(calls.length, 0);
});

test("Wiki prefill stays partial; invalid provided card is rejected and command prefill still requires a known card", () => {
  const invalidWiki = render(state({ selected: null, items: [] }), { ...wikiSelection, cardId: "unknown-card" });
  assert.ok(!invalidWiki.includes(`value="${noteId}"`));
  assert.ok(!invalidWiki.includes("Wiki revision (UUID)"));
  const invalidCommand = render(state({ selected: null, items: [] }), { kind: "command", id: "command-42", cardId: "unknown-card" });
  assert.ok(!invalidCommand.includes('value="command-42"'));
  assert.equal(calls.length, 0, "prefill/render never invokes actions");
});

test("accepted state never claims automatic prompt delivery", () => {
  const html = render(state({ selected: record("accepted") }));
  assert.ok(html.includes("Accepted; not automatically sent as a prompt."));
  assert.ok(!html.includes("Accept handoff"));
  assert.equal(calls.length, 0);
});

test("busy disables every operation button and all source form fields", () => {
  const html = render(state({ busy: true }));
  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  assert.ok(buttons.length > 0);
  assert.ok(buttons.every(tag => /disabled=\"\"/.test(tag)), "all buttons disabled while busy");
  assert.match(html, /<fieldset disabled=\"\">/);
  assert.equal(calls.length, 0);
});

test("uncertain state preserves original request details and permits only explicit reconcile/retry", () => {
  calls.length = 0;
  const pending = { kind: "propose", requestId: "original-request-9", source: { ...source, id: "<script>pending</script>" }, targetCardId: "card-target" };
  const html = render(state({ uncertain: true, pending }));
  assert.ok(html.includes("Outcome unknown"));
  assert.ok(html.includes("Original request ID:"));
  assert.ok(html.includes("original-request-9"));
  assert.ok(html.includes("targetCardId") && html.includes("card-target"));
  assert.ok(html.includes("&lt;script&gt;pending&lt;/script&gt;"));
  assert.ok(!html.includes("<script>pending</script>"));
  assert.ok(html.includes("Retry same request"));
  assert.ok(html.includes("Reconcile (read only)"));
  assert.ok(button(html, "Send transfer").includes("disabled=\"\""));
  assert.ok(button(html, "Accept handoff").includes("disabled=\"\""));
  assert.ok(!button(html, "Retry same request").includes("disabled=\"\""));
  assert.ok(!button(html, "Reconcile (read only)").includes("disabled=\"\""));
  assert.ok(html.includes("&lt;script&gt;never execute&lt;/script&gt;"));
  assert.equal(calls.length, 0, "uncertainty does not auto-reconcile or retry");
});
