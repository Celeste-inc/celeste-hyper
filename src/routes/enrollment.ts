import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import type { EnrollmentTokenRow } from "../lib/state.ts";
import { ClusterRuntimeSchema, ImageLoadSchema } from "../services/model.ts";
import { generateEnrollmentToken, hashEnrollmentToken } from "../lib/enrollment-token.ts";
import { EnrollmentService, EnrollRequestSchema } from "../services/enrollment.ts";
import { log } from "../lib/logger.ts";

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const REPO_RAW = "https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/join.sh";
const MAX_ENROLL_BODY = 384 * 1024; // kubeconfig (≤256KB) + framing; cap the unauthenticated read
const ENROLL_IP_RATE_LIMIT = 120; // broad abuse brake; valid fleet batches can still enroll
const ENROLL_TOKEN_RATE_LIMIT = 5; // brute-force/replay brake, independent of spoofable XFF
const ENROLL_RATE_WINDOW_MS = 60_000;

const CreateEnrollmentTokenBody = z.object({
  name: z.string().min(1).max(120),
  clusterId: z.string().min(1).max(63).regex(ID_RE, "lowercase letters, digits, dot, dash"),
  clusterName: z.string().min(1).max(120).optional(),
  defaultNamespace: z.string().min(1).max(63).default("default"),
  runtime: ClusterRuntimeSchema.default("k3s"),
  imageLoad: ImageLoadSchema.default("remote-pull"),
  expiresInMinutes: z.number().int().positive().max(1440).default(30),
});

/** Lifecycle status derived from the timestamps — never exposes the stored hash. */
function tokenStatus(t: EnrollmentTokenRow, nowMs: number): "active" | "used" | "revoked" | "expired" {
  if (t.revoked_at) return "revoked";
  if (t.used_at) return "used";
  if (Date.parse(t.expires_at) <= nowMs) return "expired";
  return "active";
}

function tokenView(t: EnrollmentTokenRow, nowMs: number) {
  return {
    id: t.id,
    name: t.name,
    clusterId: t.cluster_id,
    clusterName: t.cluster_name,
    defaultNamespace: t.default_namespace,
    runtime: t.runtime,
    imageLoad: t.image_load,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    usedAt: t.used_at,
    usedBy: t.used_by,
    revokedAt: t.revoked_at,
    status: tokenStatus(t, nowMs),
  };
}

/** Best-effort external base URL of this master (for the paste-ready join command). */
function masterUrl(request: Request): string {
  const url = new URL(request.url);
  const fallback = url.origin;
  const rawProto = (request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")).split(",")[0]!.trim().toLowerCase();
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : url.protocol.replace(":", "");
  const rawHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host).split(",")[0]!.trim();
  try {
    return new URL(`${proto}://${rawHost}`).origin;
  } catch {
    return fallback;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function joinCommand(request: Request, token: string): string {
  const master = masterUrl(request);
  return `curl -fsSL ${shellQuote(REPO_RAW)} | sudo env MASTER_URL=${shellQuote(master)} ENROLL_TOKEN=${shellQuote(token)} bash`;
}

function clientIp(request: Request): string {
  if (Bun.env.HYPER_TRUST_X_FORWARDED !== "1") return "direct";
  const xff = request.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0]!.trim() : "unknown";
}

function rateKeyForToken(token: string): string {
  return `token:${hashEnrollmentToken(token, "enroll-route-rate-limit")}`;
}

const tags = ["enrollment"];

export const enrollmentRoutes = (deps: ApiDeps) => {
  const service = new EnrollmentService({
    state: deps.state,
    clusters: deps.clusters,
    pool: deps.pool,
    capabilities: deps.capabilities,
    clock: deps.clock,
    authSecret: deps.auth.jwtSecret,
    clustersDir: deps.cfg.clustersDir,
  });

  // Per-IP limiter for the unauthenticated carve-out (a leaked/guessed token must not become a flood).
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const overLimit = (key: string, limit: number): boolean => {
    const now = deps.clock.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + ENROLL_RATE_WINDOW_MS };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    return bucket.count > limit;
  };

  return new Elysia()
    // ── enrollment token management (admin only via role-map) ────────
    .get(
      "/enrollment-tokens",
      () => ({ items: deps.state.listEnrollmentTokens().map((t) => tokenView(t, deps.clock.now())) }),
      { detail: { summary: "List enrollment tokens (hashes never returned)", tags } },
    )
    .post(
      "/enrollment-tokens",
      ({ body, request, status }) => {
        const parsed = CreateEnrollmentTokenBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const { name, clusterId, clusterName, defaultNamespace, runtime, imageLoad, expiresInMinutes } = parsed.data;
        if (deps.clusters.get(clusterId)) return status(400, { error: `cluster '${clusterId}' already exists` });
        const token = generateEnrollmentToken();
        const expiresAt = new Date(deps.clock.now() + expiresInMinutes * 60_000).toISOString();
        const row = deps.state.createEnrollmentToken({
          name,
          hashSha256: hashEnrollmentToken(token, deps.auth.jwtSecret),
          clusterId,
          clusterName: clusterName ?? clusterId,
          defaultNamespace,
          runtime,
          imageLoad,
          expiresAt,
        });
        log.info("enrollment-token.created", { id: row.id, clusterId, runtime, imageLoad });
        // The cleartext is returned exactly once — it is never recoverable afterward.
        return status(201, { token, joinCommand: joinCommand(request, token), enrollmentToken: tokenView(row, deps.clock.now()) });
      },
      { detail: { summary: "Mint a one-shot enrollment token (returns the cleartext once)", tags } },
    )
    .delete(
      "/enrollment-tokens/:id",
      ({ params, status }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) return status(400, { error: "invalid id" });
        if (!deps.state.revokeEnrollmentToken(id)) return status(404, { error: "not found, already used, or already revoked" });
        log.info("enrollment-token.revoked", { id });
        return { revoked: true };
      },
      { detail: { summary: "Revoke an unused enrollment token", tags } },
    )
    // ── enroll receiver (auth carve-out: the one-shot token IS the credential) ──
    .post(
      "/enroll",
      async ({ body, request, status }) => {
        const len = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(len) && len > MAX_ENROLL_BODY) return status(413, { error: "payload too large" });
        const parsed = EnrollRequestSchema.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        if (overLimit(`ip:${clientIp(request)}`, ENROLL_IP_RATE_LIMIT) || overLimit(rateKeyForToken(parsed.data.token), ENROLL_TOKEN_RATE_LIMIT)) {
          return status(429, { error: "too many requests" });
        }
        const outcome = await service.enroll(parsed.data);
        if (!outcome.ok) return status(outcome.status, { error: outcome.error });
        return status(201, { cluster: outcome.cluster });
      },
      { detail: { summary: "Worker self-registration (one-shot enrollment token)", tags } },
    );
};
