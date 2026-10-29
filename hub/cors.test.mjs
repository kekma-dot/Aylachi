import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { evaluateCors } from "./cors.mjs";

const trustedOrigin = "tauri://localhost";
const bearer = "synthetic-bearer-for-test-only";

function start(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address());
    });
  });
}

async function fixture(t) {
  let effects = 0;
  let preflightHadBearer = false;
  const server = http.createServer((req, res) => {
    const decision = evaluateCors({
      origin: req.headers.origin,
      method: req.method,
      requestedMethod: req.headers["access-control-request-method"],
      requestedHeaders: req.headers["access-control-request-headers"],
    });
    for (const [name, value] of Object.entries(decision.headers)) res.setHeader(name, value);
    if (!decision.allowed) {
      res.writeHead(403).end('{"error":"forbidden"}');
      return;
    }
    if (decision.preflight) {
      preflightHadBearer ||= req.headers.authorization !== undefined;
      res.writeHead(204).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${bearer}`) {
      res.writeHead(401).end('{"error":"unauthorized"}');
      return;
    }
    effects++;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ private: "fixture-private" }));
  });
  const address = await start(server);
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const request = (headers = {}, method = "POST") => fetch(`http://127.0.0.1:${address.port}/fixture`, { method, headers });
  return { request, effects: () => effects, preflightHadBearer: () => preflightHadBearer };
}

test("allows only the exact configured origin and safe methods/headers", () => {
  assert.deepEqual(evaluateCors({ origin: trustedOrigin, method: "GET" }), {
    allowed: true,
    preflight: false,
    headers: { "Access-Control-Allow-Origin": trustedOrigin, Vary: "Origin" },
  });
  assert.deepEqual(evaluateCors({
    origin: trustedOrigin,
    method: "OPTIONS",
    requestedMethod: "POST",
    requestedHeaders: "authorization, content-type",
  }), {
    allowed: true,
    preflight: true,
    headers: {
      "Access-Control-Allow-Origin": trustedOrigin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
  assert.deepEqual(evaluateCors({ origin: "https://app.example", method: "GET" }, "https://app.example").headers["Access-Control-Allow-Origin"], "https://app.example");
});

test("missing Origin permits non-browser methods only; bearer remains a server concern", () => {
  assert.deepEqual(evaluateCors({ method: "GET" }), { allowed: true, preflight: false, headers: {} });
  assert.deepEqual(evaluateCors({ method: "POST" }), { allowed: true, preflight: false, headers: {} });
  for (const method of ["DELETE", "PATCH", "OPTIONS", "GET\nPOST"]) {
    assert.equal(evaluateCors({ method }).allowed, false, method);
  }
  assert.equal(evaluateCors({ method: "POST", origin: undefined, requestedHeaders: "authorization" }).allowed, false);
});

test("rejects untrusted origins, preflight methods/headers, and credential requests", () => {
  for (const origin of ["null", "*", "https://evil.example", "", null, [trustedOrigin]]) {
    assert.equal(evaluateCors({ origin, method: "GET" }).allowed, false, String(origin));
  }
  for (const request of [
    { origin: trustedOrigin, method: "DELETE" },
    { origin: trustedOrigin, method: "OPTIONS" },
    { origin: trustedOrigin, method: "OPTIONS", requestedMethod: "PATCH" },
    { origin: trustedOrigin, method: "OPTIONS", requestedMethod: "POST", requestedHeaders: "cookie" },
    { origin: trustedOrigin, method: "OPTIONS", requestedMethod: "POST", requestedHeaders: "authorization, x-private" },
    { origin: trustedOrigin, method: "OPTIONS", requestedMethod: "POST", requestedHeaders: "authorization, Authorization" },
    { origin: trustedOrigin, method: "POST", requestedMethod: "POST" },
    { origin: trustedOrigin, method: "GET", credentials: true },
  ]) assert.equal(evaluateCors(request).allowed, false, JSON.stringify(request));
  assert.equal(evaluateCors({ origin: trustedOrigin, method: "GET" }, "*").allowed, false);
});

test("HTTP denies foreign Origin before effects; preflight is public but data-free; bearer remains required", async (t) => {
  const { request, effects, preflightHadBearer } = await fixture(t);

  const foreign = await request({ Origin: "https://evil.example", Authorization: `Bearer ${bearer}` });
  assert.equal(foreign.status, 403);
  assert.equal(effects(), 0);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  assert.equal((await foreign.text()).includes("fixture-private"), false);

  const preflight = await request({
    Origin: trustedOrigin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization, content-type",
  }, "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.equal(preflightHadBearer(), false);
  assert.equal(await preflight.text(), "");
  assert.equal(preflight.headers.get("access-control-allow-origin"), trustedOrigin);
  assert.equal(preflight.headers.get("vary"), "Origin");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  assert.equal(effects(), 0);

  const noBearer = await request({ Origin: trustedOrigin });
  assert.equal(noBearer.status, 401);
  assert.equal(effects(), 0);

  const authorized = await request({ Origin: trustedOrigin, Authorization: `Bearer ${bearer}` });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { private: "fixture-private" });
  assert.equal(effects(), 1);

  const nonBrowserNoBearer = await request({});
  assert.equal(nonBrowserNoBearer.status, 401);
  const nonBrowserAuthorized = await request({ Authorization: `Bearer ${bearer}` });
  assert.equal(nonBrowserAuthorized.status, 200);
  assert.equal(nonBrowserAuthorized.headers.get("access-control-allow-origin"), null);
  assert.equal(effects(), 2);
});
