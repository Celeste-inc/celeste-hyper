import type { ApiDeps } from "./deps.ts";
import { signJwt } from "../lib/jwt.ts";
import { TEST_JWT_SECRET } from "./test-fakes.ts";

interface HandleApp {
  handle(req: Request): Promise<Response>;
}

export interface CallResult {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

// A long-lived admin bearer signed with the default fake JWT secret. Since the auth guard
// only verifies the token (not a DB user), this lets the existing contract tests hit the now
// protected /api routes without each one logging in. Opt out with `{ auth: false }`.
const ADMIN_TOKEN = await signJwt({ sub: "test-admin", role: "admin" }, TEST_JWT_SECRET, { ttlSec: 315_360_000 });

export interface CallOpts {
  auth?: boolean;
  headers?: Record<string, string>;
}

export async function call(
  app: HandleApp,
  method: string,
  path: string,
  body?: unknown,
  opts: CallOpts = {},
): Promise<CallResult> {
  const init: RequestInit = { method };
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.auth !== false) headers["authorization"] = `Bearer ${ADMIN_TOKEN}`;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  if (Object.keys(headers).length > 0) init.headers = headers;
  const res = await app.handle(new Request(`http://localhost${path}`, init));
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON (e.g. SSE / html) — leave as text
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

/**
 * Read `/api/audit`, retrying until `ready(items)` holds. The trail is written in Elysia's
 * `onAfterResponse`, which runs a macrotask *after* `app.handle()` resolves, so an in-process test
 * (no network round-trip to absorb that tick) can read before the row lands. Bounded so a genuinely
 * missing row still fails the assertion instead of hanging. Production reads are unaffected.
 */
export async function pollAudit(
  app: HandleApp,
  ready: (items: any[]) => boolean,
  opts: CallOpts = {},
): Promise<CallResult> {
  let res = await call(app, "GET", "/api/audit", undefined, opts);
  for (let i = 0; i < 100 && !ready(res.body?.items ?? []); i++) {
    await new Promise((r) => setTimeout(r, 1));
    res = await call(app, "GET", "/api/audit", undefined, opts);
  }
  return res;
}

export function seedCluster(deps: ApiDeps, over: Record<string, unknown> = {}) {
  return deps.clusters.create({
    id: "primary",
    name: "Primary",
    kubeconfigPath: "/kubeconfig/primary",
    defaultNamespace: "default",
    runtime: "auto",
    enabled: true,
    ...over,
  } as any);
}

export function seedRegistryService(deps: ApiDeps, over: Record<string, unknown> = {}) {
  return deps.registry.create({
    sourceType: "registry-pull",
    name: "hello",
    namespace: "default",
    clusterId: "primary",
    imageRef: "traefik/whoami",
    workloadKind: "Deployment",
    enabled: true,
    ...over,
  } as any);
}

export function seedR2Service(deps: ApiDeps, over: Record<string, unknown> = {}) {
  return deps.registry.create({
    sourceType: "r2-bundle",
    name: "pay",
    namespace: "default",
    clusterId: "primary",
    r2Prefix: "pay/",
    manifestRoot: "k8s",
    imageTarPattern: "{name}-{tag}-amd64.tar",
    imageRefPrefix: "docker.io/library",
    enabled: true,
    ...over,
  } as any);
}
