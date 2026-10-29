const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (status, code) => Object.assign(new Error(code), { status, code });
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = value => typeof value === "string" && ID.test(value);
function decodeId(value, code) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw bad(400, code); }
  if (!safeId(decoded)) throw bad(400, code);
  return decoded;
}

function routeParts(path) {
  if (typeof path !== "string" || path.length > 512 || !path.startsWith("/v1/modules/")) throw new TypeError("invalid module route path");
  const segments = path.slice(1).split("/");
  if (segments.length < 3 || segments.length > 16 || segments[0] !== "v1" || segments[1] !== "modules" || !/^[a-z][a-z0-9-]{0,63}$/.test(segments[2])) throw new TypeError("invalid module route path");
  const names = new Set();
  return segments.map((segment, index) => {
    if (index >= 3 && segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || names.has(name)) throw new TypeError("invalid module route parameter");
      names.add(name);
      return Object.freeze({ name });
    }
    if (segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]{1,128}$/.test(segment)) throw new TypeError("invalid module route segment");
    return Object.freeze({ literal: segment });
  });
}

function routesOverlap(a, b) {
  return a.method === b.method && a.parts.length === b.parts.length &&
    a.parts.every((part, index) => part.name || b.parts[index].name || part.literal === b.parts[index].literal);
}

export function compileRouteHandlers(handlers) {
  const keys = ["method", "path", "operation", "effect", "target", "handle"];
  if (!Array.isArray(handlers) || handlers.length > 100) throw new TypeError("routeHandlers must be an array of at most 100 routes");
  const routes = [];
  for (const handler of handlers) {
    if (!isObject(handler) || Object.keys(handler).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(handler, key)) ||
        !["GET", "POST"].includes(handler.method) || !safeId(handler.operation) || !["read", "write"].includes(handler.effect) || typeof handler.handle !== "function" ||
        !isObject(handler.target) || Object.keys(handler.target).length !== 1 || !safeId(handler.target.projectId)) throw new TypeError("invalid module route descriptor");
    const route = Object.freeze({
      method: handler.method,
      path: handler.path,
      parts: Object.freeze(routeParts(handler.path)),
      operation: handler.operation,
      effect: handler.effect,
      target: Object.freeze({ projectId: handler.target.projectId }),
      handle: handler.handle,
    });
    if (routes.some((existing) => routesOverlap(existing, route))) throw new TypeError("duplicate or colliding module route");
    routes.push(route);
  }
  return routes;
}

export function matchModuleRoute(routes, method, pathname) {
  const actual = pathname.slice(1).split("/");
  for (const route of routes) {
    if (route.method !== method || route.parts.length !== actual.length ||
        route.parts.some((part, index) => part.literal !== undefined && part.literal !== actual[index])) continue;
    const params = {};
    for (let i = 0; i < actual.length; i++) {
      const part = route.parts[i];
      if (part.name) params[part.name] = decodeId(actual[i], "invalid_module_param");
    }
    return { route, params };
  }
  return null;
}

export function moduleQuery(url) {
  const entries = [], seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (entries.length >= 16 || !key || Buffer.byteLength(key, "utf8") > 128 || Buffer.byteLength(value, "utf8") > 512 || seen.has(key)) throw bad(400, "invalid_module_query");
    seen.add(key);
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}
