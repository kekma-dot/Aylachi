// HTTP responses stay below the Hub transport cap; the filesystem API keeps its 1 MiB content limit.
const OUTPUT_LIMIT = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION = /^[a-f0-9-]{36}$/i;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const checkedRevision = value => {
  if (typeof value !== "string" || !REVISION.test(value)) throw fail(400, "invalid_request");
  return value;
};

function exactKeys(value, allowed, required = []) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !own(value, key))) throw fail(400, "invalid_request");
}

function context(raw, route) {
  if (!plain(raw)) throw fail(400, "invalid_request");
  const params = raw.params ?? {};
  const query = raw.query ?? {};
  const body = raw.body ?? {};
  exactKeys(params, route.params);
  exactKeys(query, route.query, route.requiredQuery);
  if (Object.keys(query).length > 16 || Object.entries(query).some(([key, value]) =>
    Buffer.byteLength(key, "utf8") > 512 || typeof value !== "string" || Buffer.byteLength(value, "utf8") > 512)) {
    throw fail(400, "invalid_request");
  }
  exactKeys(body, route.body, route.requiredBody);
  for (const value of Object.values(body)) if (typeof value !== "string") throw fail(400, "invalid_request");
  return { actor: raw.actor, params, query, body };
}

function publicError(error) {
  if (error?.status === 413 && error?.code === "too_large") return fail(413, "too_large");
  switch (error?.code) {
    case "FORBIDDEN":
    case "ENOENT": return fail(404, "not_found");
    case "CONFLICT":
    case "WRITE_BUSY": return fail(409, "conflict");
    case "INVALID_ID":
    case "INVALID_REVISION":
    case "INVALID_CONTENT":
    case "INVALID_QUERY": return fail(400, "invalid_request");
    default:
      if (error?.status === 400 && error?.code === "invalid_request") return fail(400, "invalid_request");
      return fail(500, "internal_error");
  }
}

export function createWikiRouteHandlers({ wiki, projectId } = {}) {
  const methods = ["create", "read", "update", "history", "restore", "search", "diff", "links"];
  if (!wiki || methods.some(method => typeof wiki[method] !== "function") ||
      typeof projectId !== "string" || !ID.test(projectId)) throw new TypeError("wiki and trusted projectId required");
  const target = Object.freeze({ projectId });
  const specs = [
    { method: "POST", path: "/v1/modules/wiki/notes", operation: "wiki.create", effect: "write", params: [], query: [], body: ["content"], requiredBody: ["content"], status: 201,
      run: ({ actor, body }) => wiki.create({ actor, content: body.content }),
      shape: result => ({ id: result.id, revision: result.revision }) },
    { method: "GET", path: "/v1/modules/wiki/notes", operation: "wiki.search", effect: "read", params: [], query: ["query"], run: ({ actor, query }) => wiki.search({ actor, query: query.query }),
      shape: notes => ({ notes }) },
    { method: "GET", path: "/v1/modules/wiki/notes/:id", operation: "wiki.read", effect: "read", params: ["id"], query: ["revision"], run: ({ actor, params, query }) => wiki.read({ actor, id: params.id, revision: query.revision === undefined ? undefined : checkedRevision(query.revision) }),
      shape: ({ id, revision, content }) => ({ id, revision, content }) },
    { method: "POST", path: "/v1/modules/wiki/notes/:id", operation: "wiki.write", effect: "write", params: ["id"], query: [], body: ["content", "expectedRevision"], requiredBody: ["content", "expectedRevision"],
      run: ({ actor, params, body }) => wiki.update({ actor, id: params.id, content: body.content, expectedRevision: checkedRevision(body.expectedRevision) }),
      shape: result => ({ id: result.id, revision: result.revision }) },
    { method: "GET", path: "/v1/modules/wiki/notes/:id/history", operation: "wiki.history", effect: "read", params: ["id"], query: [],
      run: ({ actor, params }) => wiki.history({ actor, id: params.id }), shape: revisions => ({ revisions }) },
    { method: "GET", path: "/v1/modules/wiki/notes/:id/diff", operation: "wiki.diff", effect: "read", params: ["id"], query: ["fromRevision", "toRevision"], requiredQuery: ["fromRevision", "toRevision"],
      run: ({ actor, params, query }) => wiki.diff({ actor, id: params.id, fromRevision: checkedRevision(query.fromRevision), toRevision: checkedRevision(query.toRevision) }), shape: changes => ({ changes }) },
    { method: "POST", path: "/v1/modules/wiki/notes/:id/restore", operation: "wiki.restore", effect: "write", params: ["id"], query: [], body: ["revision", "expectedRevision"], requiredBody: ["revision", "expectedRevision"],
      run: ({ actor, params, body }) => wiki.restore({ actor, id: params.id, revision: checkedRevision(body.revision), expectedRevision: checkedRevision(body.expectedRevision) }),
      shape: result => ({ id: result.id, revision: result.revision }) },
    { method: "GET", path: "/v1/modules/wiki/notes/:id/links", operation: "wiki.links", effect: "read", params: ["id"], query: [],
      run: ({ actor, params }) => wiki.links({ actor, id: params.id }), shape: links => ({ links }) },
  ];
  return Object.freeze(specs.map(spec => Object.freeze({
    method: spec.method,
    path: spec.path,
    operation: spec.operation,
    effect: spec.effect,
    target,
    handle: async raw => {
      try {
        const args = context(raw, spec);
        const result = await spec.run(args);
        const body = spec.shape(result);
        if (Buffer.byteLength(JSON.stringify(body), "utf8") > OUTPUT_LIMIT) throw fail(413, "too_large");
        return { status: spec.status ?? 200, body };
      } catch (error) {
        throw publicError(error);
      }
    },
  })));
}
