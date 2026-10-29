const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REF_KEYS = ["projectId", "cardId", "sessionId"];
const GRANT_KEYS = new Set(["effect", "permission", "operation", ...REF_KEYS]);
const EFFECTS = new Set(["read", "write"]);
const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function validRef(value) {
  return value === undefined || (typeof value === "string" && ID.test(value));
}

function validGrant(g) {
  return record(g) && Object.keys(g).every((key) => GRANT_KEYS.has(key)) &&
    (g.effect === "allow" || g.effect === "deny") &&
    EFFECTS.has(g.permission) && typeof g.operation === "string" && ID.test(g.operation) &&
    REF_KEYS.every((key) => validRef(g[key]));
}

function covers(grant, request) {
  return grant.operation === request.operation && grant.permission === request.effect &&
    REF_KEYS.every((key) => grant[key] === undefined || grant[key] === request[key]);
}

function grantWithinParent(grant, parentGrants) {
  const parentAllows = parentGrants.some((parent) => parent.effect === "allow" &&
    parent.operation === grant.operation && parent.permission === grant.permission &&
    REF_KEYS.every((key) => parent[key] === undefined || parent[key] === grant[key]));
  const overlapsParentDeny = parentGrants.some((parent) => parent.effect === "deny" &&
    parent.operation === grant.operation && parent.permission === grant.permission &&
    REF_KEYS.every((key) => parent[key] === undefined || grant[key] === undefined || parent[key] === grant[key]));
  return parentAllows && !overlapsParentDeny;
}

/** descriptor must come from trusted server code (operation registry + resource lookup). */
export function authorize(context, input, descriptor, now = Date.now()) {
  if (!record(context) || typeof context.principalId !== "string" || !ID.test(context.principalId) ||
      !Number.isFinite(context.expiresAt) || context.expiresAt <= now || context.revoked !== false ||
      !Array.isArray(context.grants) || !context.grants.every(validGrant) ||
      (context.delegated && (!Array.isArray(context.parentGrants) || !context.parentGrants.every(validGrant)))) {
    return { allowed: false, reason: "invalid_context" };
  }
  if (!record(input) || typeof input.operation !== "string" || !ID.test(input.operation) ||
      typeof input.requestId !== "string" || !ID.test(input.requestId) ||
      (owns(input, "effect") && input.effect !== descriptor?.effect) ||
      !REF_KEYS.every((key) => validRef(input[key]))) {
    return { allowed: false, reason: "invalid_request" };
  }
  if (!record(descriptor) || descriptor.operation !== input.operation ||
      !EFFECTS.has(descriptor.effect) || !REF_KEYS.every((key) => validRef(descriptor[key])) ||
      REF_KEYS.some((key) => owns(input, key) && input[key] !== descriptor[key])) {
    return { allowed: false, reason: "invalid_descriptor" };
  }
  const request = { operation: descriptor.operation, effect: descriptor.effect };
  for (const key of REF_KEYS) if (owns(descriptor, key)) request[key] = descriptor[key];

  const grants = context.grants;
  if (grants.some((g) => g.effect === "deny" && covers(g, request))) {
    return { allowed: false, reason: "denied" };
  }
  const matching = grants.filter((g) => g.effect === "allow" && covers(g, request));
  if (context.delegated && matching.some((g) => !grantWithinParent(g, context.parentGrants))) {
    return { allowed: false, reason: "delegation_exceeds_parent" };
  }
  return matching.length
    ? { allowed: true, principalId: context.principalId, requestId: input.requestId }
    : { allowed: false, reason: "not_granted" };
}
