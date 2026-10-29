import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const modules = `${root}node_modules`;
const aliases = [
  { find: "react/jsx-runtime", replacement: `${modules}/react/jsx-runtime.js` },
  { find: "react/jsx-dev-runtime", replacement: `${modules}/react/jsx-dev-runtime.js` },
  { find: "react-dom/client", replacement: `${modules}/react-dom/client.js` },
  { find: "react-dom/test-utils", replacement: `${modules}/react-dom/test-utils.js` },
  { find: "react-dom", replacement: `${modules}/react-dom/index.js` },
  { find: "react", replacement: `${modules}/react/index.js` },
  { find: "@xyflow/react", replacement: `${modules}/@xyflow/react` },
];
let vite;
let ChatCard;
let repairWrappedCaret;

async function loadChatCard() {
  const { createServer } = await import("vite");
  vite = await createServer({
    configFile: new URL("./vite.config.js", import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  ({ ChatCard, repairWrappedCaret } = await vite.ssrLoadModule("/ChatCard.jsx"));
}

const card = { id: "card-a", sessionId: "session-a", title: "Session A", revision: 1 };
function renderCard(status) {
  return renderToStaticMarkup(React.createElement(ChatCard, { card, status, onSend: async () => ({ accepted: true }) }));
}

if (!process.argv.includes("--browser")) {
  before(loadChatCard);
  after(async () => { await vite?.close(); });
  test("Canvas has no List mode; scroll pans and nodes drag only from headings", async () => {
    const canvas = await readFile(new URL("./Canvas.jsx", import.meta.url), "utf8");
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    assert.doesNotMatch(canvas, /listMode|layout-switch|>List</);
    assert.match(canvas, /fitView panOnDrag=\{!focusedNodeId\} panOnScroll=\{!focusedNodeId\} zoomOnScroll=\{false\} zoomOnPinch=\{!focusedNodeId\} zoomOnDoubleClick=\{!focusedNodeId\} preventScrolling/,
      'ordinary two-finger scroll pans; focus locks every camera gesture');
    assert.doesNotMatch(canvas, /keepAspectRatio/, 'ordinary canvas nodes keep free width and height resizing');
    assert.match(canvas, /showZoom=\{!focusedNodeId\}/, 'focus also removes manual camera zoom controls');
    assert.match(canvas, /nodesDraggable=\{Boolean\(onMove\) && !focusedNodeId\}/,
      'ordinary nodes drag from headings; virtual focus columns stay fixed');
    assert.equal((canvas.match(/dragHandle: ['"]\.card-heading['"]/g) ?? []).length, 2,
      "chat and definition nodes must drag only from their heading");
    assert.doesNotMatch(css, /\.aylachi\.list|\.canvas-shell\.list|\.layout-switch/);
    assert.match(css, /html,body,#root\{[^}]*overflow:hidden;overscroll-behavior:none/, 'the native webview root cannot rubber-band into a white window border');
    assert.match(css, /\.chat-card-content\{display:flex;flex:0 0 auto;/, 'inverse-height focus content cannot be flex-shrunk before its scale transform');
  });
  test("Chat composer keeps send inside the input and omits the redundant hint", () => {
    const html = renderCard("ready");
    assert.match(html, /<div class="composer-field"><textarea[\s\S]*<button[^>]*type="submit"/);
    assert.doesNotMatch(html, />Message Ayla</);
    assert.doesNotMatch(html, /composer-hint/);
    assert.match(html, /<textarea[^>]*autocorrect="off"[^>]*autocapitalize="off"[^>]*autocomplete="off"[^>]*spellcheck="false"/i,
      'WKWebView automatic text replacement must not move the composer caret');
  });
  test("WKWebView wrap correction advances only a stale caret after append-at-end", () => {
    const wrapped = { value: "a".repeat(50), selectionStart: 49, selectionEnd: 49,
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
    repairWrappedCaret(wrapped, { value: "a".repeat(49), start: 49, end: 49 }, "insertText");
    assert.equal(wrapped.selectionStart, 50);
    assert.equal(wrapped.selectionEnd, 50);
    const middle = { value: "aXbc", selectionStart: 1, selectionEnd: 1,
      setSelectionRange() { throw new Error("middle insertion must not be rewritten"); } };
    repairWrappedCaret(middle, { value: "abc", start: 1, end: 1 }, "insertText");
    assert.equal(middle.selectionStart, 1);
    assert.equal(middle.selectionEnd, 1);
  });
  test("Disconnected/error/running block sends; reconciliation keeps draft locked and labels the explicit action", () => {
    for (const status of ["disconnected", "error", "running"]) {
      const html = renderCard(status);
      assert.match(html, /<textarea[^>]*disabled=""/i, `${status} textarea must stay disabled`);
      assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/i, `${status} send must stay disabled`);
    }
    const reconciliation = renderCard("reconciliation");
    assert.match(reconciliation, /<textarea[^>]*disabled=""/i, "reconciliation must keep the draft locked");
    assert.match(reconciliation, />Reconcile send</, "reconciliation remains an explicit user action");
  });
}

const browserClient = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import Canvas from "/Canvas.jsx";
import "/styles.css";

const cards = [
  { id: "parent-a", sessionId: "session-parent", canvasId: "fixture", revision: 1, title: "Synthetic parent", x: 0, y: 0 },
  { id: "peer-b", sessionId: "session-peer", canvasId: "fixture", revision: 1, title: "Synthetic peer", x: 900, y: 50 },
  { id: "offline-c", sessionId: "session-offline", canvasId: "fixture", revision: 1, title: "Disconnected peer", x: 1800, y: 100 },
];
const messagesBySession = {
  "session-parent": [{ id: "p1", role: "assistant", text: "Short transcript." }],
  "session-peer": Array.from({ length: 5 }, (_, i) => ({ id: "s" + i, role: i % 2 ? "assistant" : "user", text: "Variable-height transcript " + (i + 1) + ": " + "Longer card content used to test real flow and scrolling. ".repeat(5) })),
  "session-offline": [{ id: "o1", role: "assistant", text: "This card remains disconnected and its composer must stay disabled." }],
};
const sendCalls = [];
const moveCalls = [];
const trusted = { clicks: [], focuses: [], inputs: [], submits: [] };
let pendingResolve;
let pendingDraft = null;
let pendingAccepted = false;
let unknownDraft = null;
let unknownOutcomeSeen = false;
let statusBySession = { "session-parent": "ready", "session-peer": "ready", "session-offline": "disconnected" };
const report = document.getElementById("report");
const root = createRoot(document.getElementById("root"));
function render() {
  root.render(React.createElement(Canvas, {
    cards, messagesBySession, statusBySession,
    connectionLabel: "Synthetic layout regression",
    onMove: (...args) => { moveCalls.push(args); snapshot(); },
    onSend: async value => {
      sendCalls.push(value);
      if (value.cardId === "parent-a") {
        pendingDraft = value.text;
        return await new Promise(resolve => { pendingResolve = resolve; updateControls(); setTimeout(snapshot, 0); });
      }
      if (value.cardId === "peer-b") {
        unknownDraft = value.text;
        unknownOutcomeSeen = true;
        statusBySession = { ...statusBySession, "session-peer": "reconciliation" };
        render();
        setTimeout(snapshot, 50);
        return { accepted: false, message: "Outcome unknown; draft preserved." };
      }
      return { accepted: true };
    },
  }));
  updateControls();
}
function rect(element) {
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
}
function snapshot() {
  const main = document.querySelector(".aylachi");
  const workspace = document.querySelector(".workspace");
  const viewport = document.querySelector(".react-flow__viewport");
  const layer = document.querySelector(".react-flow__nodes");
  const nodes = [...document.querySelectorAll(".react-flow__node-chat")];
  const items = nodes.map(node => {
    const input = node.querySelector("textarea");
    const r = input.getBoundingClientRect();
    const inViewport = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    const hit = inViewport ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return {
      id: node.dataset.id,
      node: rect(node),
      textarea: { ...rect(input), disabled: input.disabled, pointerEvents: getComputedStyle(input).pointerEvents, focused: document.activeElement === input, value: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd },
      nodePointerEvents: getComputedStyle(node).pointerEvents,
      sendDisabled: node.querySelector('button[type="submit"]')?.disabled,
      submitLabel: node.querySelector('button[type="submit"]')?.textContent.trim(),
      inViewport,
      centerHitTextarea: hit === input,
    };
  });
  const reportData = {
    layout: main?.className,
    viewport: { width: innerWidth, height: innerHeight, workspaceHeight: workspace?.clientHeight, workspaceScrollHeight: workspace?.scrollHeight, workspaceScrollTop: workspace?.scrollTop, documentHeight: document.scrollingElement?.clientHeight, documentScrollHeight: document.scrollingElement?.scrollHeight, documentScrollTop: document.scrollingElement?.scrollTop, transform: viewport && getComputedStyle(viewport).transform },
    cards: items,
    sendCalls: [...sendCalls],
    moveCalls: moveCalls.length,
    scenarios: {
      pending: { started: pendingDraft !== null, waiting: !!pendingResolve, draftPreservedWhileWaiting: pendingResolve ? items.find(item => item.id === "parent-a")?.textarea.value === pendingDraft : null, textareaLockedWhileWaiting: pendingResolve ? items.find(item => item.id === "parent-a")?.textarea.disabled === true : null, accepted: pendingAccepted, draftClearedAfterReceipt: pendingAccepted ? items.find(item => item.id === "parent-a")?.textarea.value === "" : null },
      unknown: { started: unknownOutcomeSeen, draftPreserved: unknownOutcomeSeen ? items.find(item => item.id === "peer-b")?.textarea.value === unknownDraft : null, textareaLocked: unknownOutcomeSeen ? items.find(item => item.id === "peer-b")?.textarea.disabled === true : null, explicitReconcileLabel: unknownOutcomeSeen ? items.find(item => item.id === "peer-b")?.submitLabel === "Reconcile send" : null, reconcileActionEnabled: unknownOutcomeSeen ? items.find(item => item.id === "peer-b")?.sendDisabled === false : null, oneAttemptOnly: unknownOutcomeSeen ? sendCalls.filter(call => call.cardId === "peer-b").length === 1 : null },
      trustedInput: { clicks: trusted.clicks, focuses: trusted.focuses, inputs: trusted.inputs, submits: trusted.submits },
    },
    assertions: {
      threeCards: items.length === 3,
      pointerTargetsEnabled: items.every(item => item.nodePointerEvents !== "none" && item.textarea.pointerEvents !== "none"),
      disconnectedComposerBlocked: items.find(item => item.id === "offline-c")?.textarea.disabled === true && items.find(item => item.id === "offline-c")?.sendDisabled === true,
      noUnexpectedMove: moveCalls.length === 0,
      sendPayloadsBoundToCards: sendCalls.some(call => call.cardId === "parent-a" && call.sessionId === "session-parent") && sendCalls.some(call => call.cardId === "peer-b" && call.sessionId === "session-peer") && sendCalls.every(call => (call.cardId === "parent-a" && call.sessionId === "session-parent") || (call.cardId === "peer-b" && call.sessionId === "session-peer")),
      trustedClickFocusTypeSend: trusted.clicks.some(item => item.trusted && item.targetIsTextarea && item.hitId === item.id) && trusted.focuses.some(item => item.trusted) && trusted.inputs.some(item => item.trusted) && trusted.submits.some(item => item.trusted),
      pendingReceiptPreservesThenClears: pendingDraft !== null && (pendingResolve ? items.find(item => item.id === "parent-a")?.textarea.disabled && items.find(item => item.id === "parent-a")?.textarea.value === pendingDraft : pendingAccepted && items.find(item => item.id === "parent-a")?.textarea.value === ""),
      unknownOutcomePreservesAndRequiresExplicitReconcile: unknownOutcomeSeen && items.find(item => item.id === "peer-b")?.textarea.value === unknownDraft && items.find(item => item.id === "peer-b")?.textarea.disabled && items.find(item => item.id === "peer-b")?.submitLabel === "Reconcile send" && items.find(item => item.id === "peer-b")?.sendDisabled === false && sendCalls.filter(call => call.cardId === "peer-b").length === 1,
    },
  };
  report.textContent = JSON.stringify(reportData, null, 2);
  report.dataset.pass = Object.values(reportData.assertions).every(Boolean) ? "true" : "false";
  return reportData;
}
function updateControls() {
  const offline = statusBySession["session-peer"] === "disconnected";
  document.getElementById("peer-status").textContent = offline ? "Set peer ready" : "Set peer disconnected";
  document.getElementById("resolve-pending").disabled = !pendingResolve;
}
document.addEventListener("click", event => {
  const input = event.target.closest?.(".react-flow__node-chat textarea");
  if (input) trusted.clicks.push({ id: input.id, trusted: event.isTrusted, targetIsTextarea: event.target === input, hitId: document.elementFromPoint(event.clientX, event.clientY)?.id ?? null });
}, true);
document.addEventListener("focusin", event => {
  if (event.target.matches?.(".react-flow__node-chat textarea")) trusted.focuses.push({ id: event.target.id, trusted: event.isTrusted });
}, true);
document.addEventListener("input", event => {
  if (event.target.matches?.(".react-flow__node-chat textarea")) trusted.inputs.push({ id: event.target.id, value: event.target.value, trusted: event.isTrusted });
}, true);
document.addEventListener("submit", event => {
  const node = event.target.closest?.(".react-flow__node-chat");
  trusted.submits.push({ id: node?.dataset.id, trusted: event.isTrusted });
}, true);
document.getElementById("check-layout").addEventListener("click", snapshot);
document.getElementById("peer-status").addEventListener("click", () => {
  statusBySession = { ...statusBySession, "session-peer": statusBySession["session-peer"] === "disconnected" ? "ready" : "disconnected" };
  render();
  setTimeout(snapshot, 50);
});
document.getElementById("resolve-pending").addEventListener("click", () => {
  const resolve = pendingResolve;
  pendingResolve = null;
  pendingAccepted = true;
  updateControls();
  resolve?.({ accepted: true });
  setTimeout(snapshot, 50);
});
render();
// Stress the composer: background updates must not rewrite text or move the caret.
setInterval(render, 100);
window.__canvasLayoutSnapshot = snapshot;
setTimeout(snapshot, 100);
`;

async function startBrowser() {
  const { createServer } = await import("vite");
  const reactPlugin = (await import("@vitejs/plugin-react")).default;
  const plugin = {
    name: "canvas-layout-browser-regression",
    resolveId(id) { return id === "virtual:canvas-layout-browser" ? "\0canvas-layout-browser" : null; },
    load(id) { return id === "\0canvas-layout-browser" ? browserClient : null; },
    configureServer(server) {
      server.middlewares.use("/__canvas-layout-test", (_req, res) => {
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas layout regression</title><style>html,body{margin:0}#regression{position:fixed;right:12px;top:68px;z-index:10000;width:min(380px,30vw);max-height:42vh;overflow:auto;background:#fff;color:#111;border:2px solid #111;padding:8px;font:12px/1.3 ui-monospace,monospace}#report{white-space:pre-wrap;margin:8px 0 0}#regression button{font:inherit;margin-right:4px}</style></head><body><div id="root"></div><aside id="regression"><button id="check-layout" type="button">Check layout</button><button id="peer-status" type="button">Set peer disconnected</button><button id="resolve-pending" type="button" disabled>Accept pending receipt</button><pre id="report" role="status" aria-live="polite">Waiting for React render…</pre></aside><script type="module" src="/@id/__x00__canvas-layout-browser"></script></body></html>`;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
      });
    },
  };
  const server = await createServer({
    configFile: false,
    root,
    plugins: [reactPlugin(), plugin],
    resolve: { dedupe: ["react", "react-dom"], alias: aliases },
    optimizeDeps: { include: ["react", "react-dom/client", "@xyflow/react"] },
    server: { host: "127.0.0.1", port: 4177, strictPort: true, hmr: false, ws: false },
    appType: "custom",
  });
  await server.listen();
  console.log("Open http://127.0.0.1:4177/__canvas-layout-test; use normal browser clicks/typing, not force-fill. Ctrl-C stops the fixture.");
  process.on("SIGINT", async () => { await server.close(); process.exit(0); });
}

if (process.argv.includes("--browser")) {
  await startBrowser();
} else {
  test("browser regression fixture is available via --browser", () => {
    assert.ok(browserClient.includes("document.elementFromPoint"));
    assert.ok(browserClient.includes("Outcome unknown; draft preserved."));
    assert.ok(browserClient.includes("pendingResolve"));
    assert.ok(browserClient.includes("selectionStart: input.selectionStart"));
    assert.ok(browserClient.includes("setInterval(render, 100)"));
  });
}
