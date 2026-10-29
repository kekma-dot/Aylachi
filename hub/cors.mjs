const METHODS = new Set(["GET", "POST"]);
const HEADERS = new Set(["authorization", "content-type"]);

function exactOrigin(value) {
  if (typeof value !== "string" || !value || value === "*" || value === "null" || /[\s,\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.protocol && url.host) && !url.username && !url.password &&
      (url.pathname === "" || url.pathname === "/") && !url.search && !url.hash &&
      value === `${url.protocol}//${url.host}`;
  } catch { return false; }
}

function requestedHeaderNames(value) {
  if (value === undefined) return [];
  if (typeof value !== "string") return null;
  const names = value.split(",").map((name) => name.trim().toLowerCase());
  if (names.some((name) => !name || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) || new Set(names).size !== names.length) return null;
  return names;
}

function denied(preflight = false) { return { allowed: false, preflight, headers: {} }; }

/**
 * Pure CORS policy, not authentication or CSRF protection. The default
 * tauri://localhost is provisional: native clients must confirm their actual
 * Origin with L04 before integration. Missing Origin permits non-browser
 * GET/POST clients only; the HTTP server must still require its bearer.
 */
export function evaluateCors(request, allowedOrigin = "tauri://localhost") {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some((key) => !["origin", "method", "requestedMethod", "requestedHeaders"].includes(key)) ||
      !exactOrigin(allowedOrigin)) return denied(request?.method === "OPTIONS");

  const { origin, method, requestedMethod, requestedHeaders } = request;
  const preflight = method === "OPTIONS";
  if (!METHODS.has(method) && !preflight) return denied(false);
  const hasPreflightMetadata = requestedMethod !== undefined || requestedHeaders !== undefined;
  if (!preflight && hasPreflightMetadata) return denied(false);

  if (origin === undefined) {
    return !preflight && !hasPreflightMetadata
      ? { allowed: true, preflight: false, headers: {} }
      : denied(preflight);
  }
  if (typeof origin !== "string" || !exactOrigin(origin) || origin !== allowedOrigin) return denied(preflight);

  const headers = { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" };
  if (!preflight) return { allowed: true, preflight: false, headers };

  const names = requestedHeaderNames(requestedHeaders);
  if (!METHODS.has(requestedMethod) || names === null || names.some((name) => !HEADERS.has(name))) return denied(true);
  headers["Access-Control-Allow-Methods"] = "GET, POST";
  if (names.length) {
    headers["Access-Control-Allow-Headers"] = [
      ...(names.includes("authorization") ? ["Authorization"] : []),
      ...(names.includes("content-type") ? ["Content-Type"] : []),
    ].join(", ");
  }
  return { allowed: true, preflight: true, headers };
}
