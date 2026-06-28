import type { Role } from "../lib/state.ts";

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/** True if `have` (a user's role) meets or exceeds the `need` role. */
export function hasRole(have: string, need: Role): boolean {
  const h = RANK[have as Role];
  return h !== undefined && h >= RANK[need];
}

export function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

// Any authenticated user may use these (read-your-own / self-service), regardless of role.
const SELF_SERVICE = new Set(["/api/me", "/api/logout", "/api/change-password"]);
// POSTs that are semantically reads: minting a one-shot log-stream token is a read-level
// capability (EventSource can't send a bearer header), so viewers may mint it.
const READ_MUTATIONS = [/^\/api\/services\/[^/]+\/logs\/token$/];
// GETs that expose raw cluster objects: viewers can see derived endpoints, but the underlying
// Ingress YAML (hostnames, TLS secret names, internal annotations) is operator+ only. The admission
// preflight (P3.3) is also operator+: it drives the full admission chain (external webhooks, image
// signature checks) and returns policy-internal denial reasons, so it's heavier + more sensitive
// than a passive read.
const OPERATOR_READS = [
  /^\/api\/clusters\/[^/]+\/ingresses\//,
  /^\/api\/clusters\/[^/]+\/crds/, // custom resources expose raw cluster objects (P3.1)
  /^\/api\/services\/[^/]+\/preflight$/,
];
// Admin-only surface; matched by exact path or prefix. Machine tokens and webhook management mint or
// revoke credentials, so they are admin-only (P1.10). The webhook *receiver*
// (/api/webhooks/registry/:secretId) is an auth carve-out and never reaches this check.
const ADMIN_ONLY_PREFIXES = ["/api/users", "/api/machine-tokens", "/api/webhooks", "/api/discovery", "/api/settings", "/api/setup"];

/**
 * The minimum role required for `method path`. Reads → viewer; mutations → operator;
 * self-service auth routes → viewer; the reserved admin surface → admin.
 */
export function requiredRole(method: string, path: string): Role {
  if (SELF_SERVICE.has(path)) return "viewer";
  if (READ_MUTATIONS.some((re) => re.test(path))) return "viewer";
  if (OPERATOR_READS.some((re) => re.test(path))) return "operator";
  if (ADMIN_ONLY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return "admin";
  return isMutation(method) ? "operator" : "viewer";
}
