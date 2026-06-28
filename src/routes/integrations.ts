import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import type { MachineTokenRow, WebhookRow } from "../lib/state.ts";
import { DEPLOY_JOB_KIND } from "../queue/handlers/deploy.ts";
import { generateMachineToken, hashMachineToken, generateSecretId, generateWebhookSecret } from "../lib/machine-token.ts";
import { parseRegistryPush, verifyWebhookSignature, type RegistryKind } from "../lib/registry-webhooks.ts";
import { log } from "../lib/logger.ts";

const REGISTRY_KINDS = ["dockerhub", "ghcr", "acr", "generic"] as const;

const CreateTokenBody = z.object({
  name: z.string().min(1).max(120),
  role: z.enum(["operator", "viewer"]), // never admin — machine tokens can't manage credentials
  serviceScope: z.string().min(1).nullish(),
  clusterScope: z.string().min(1).nullish(),
  expiresInDays: z.number().int().positive().max(3650).nullish(),
});

const CreateWebhookBody = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(REGISTRY_KINDS),
  serviceScope: z.string().min(1).nullish(),
  clusterScope: z.string().min(1).nullish(),
});

const MAX_WEBHOOK_BODY = 256 * 1024; // a registry push payload is tiny; cap the unauthenticated read
const WEBHOOK_RATE_LIMIT = 30; // requests per window per client IP
const WEBHOOK_RATE_WINDOW_MS = 60_000;

/** Public view of a token row — never includes the hash. The cleartext is only returned on create. */
function tokenView(t: MachineTokenRow) {
  return {
    id: t.id,
    name: t.name,
    role: t.role,
    serviceScope: t.service_scope,
    clusterScope: t.cluster_scope,
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
    expiresAt: t.expires_at,
    revokedAt: t.revoked_at,
  };
}

/** Public view of a webhook — the URL (capability) is shown, the HMAC secret is shown only on create. */
function webhookView(w: WebhookRow) {
  return {
    id: w.id,
    name: w.name,
    kind: w.kind,
    secretId: w.secret_id,
    url: `/api/webhooks/registry/${w.secret_id}`,
    serviceScope: w.service_scope,
    clusterScope: w.cluster_scope,
    createdAt: w.created_at,
    lastUsedAt: w.last_used_at,
    revokedAt: w.revoked_at,
  };
}

/** docker.io / library defaults make "x", "docker.io/x", "docker.io/library/x" the same image. */
function normalizeImageRef(ref: string): string {
  let r = ref.trim().toLowerCase();
  const at = r.indexOf("@");
  if (at >= 0) r = r.slice(0, at); // drop any digest
  r = r.replace(/^(?:registry-1\.|index\.)?docker\.io\//, "");
  r = r.replace(/^library\//, "");
  return r;
}

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0]!.trim() : "unknown";
}

export const integrationRoutes = (deps: ApiDeps) => {
  // Per-IP rate limit for the unauthenticated webhook receiver (a leaked secretId must not become a
  // DB/deploy flood). Same in-process bucket shape as the login limiter.
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const overLimit = (ip: string): boolean => {
    const now = deps.clock.now();
    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + WEBHOOK_RATE_WINDOW_MS };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    return bucket.count > WEBHOOK_RATE_LIMIT;
  };

  return new Elysia()
    // ── machine tokens (admin only via role-map) ─────────────────────
    .get(
      "/machine-tokens",
      () => ({ items: deps.state.listMachineTokens().map(tokenView) }),
      { detail: { summary: "List machine tokens (hashes never returned)", tags: ["integrations"] } },
    )
    .post(
      "/machine-tokens",
      ({ body, status }) => {
        const parsed = CreateTokenBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const { name, role, serviceScope, clusterScope, expiresInDays } = parsed.data;
        if (serviceScope && !deps.registry.get(serviceScope)) return status(400, { error: `service '${serviceScope}' not found` });
        if (clusterScope && !deps.clusters.get(clusterScope)) return status(400, { error: `cluster '${clusterScope}' not found` });
        const token = generateMachineToken();
        const expiresAt = expiresInDays ? new Date(deps.clock.now() + expiresInDays * 86_400_000).toISOString() : null;
        try {
          const row = deps.state.createMachineToken({
            name,
            hashSha256: hashMachineToken(token, deps.auth.jwtSecret),
            role,
            serviceScope: serviceScope ?? null,
            clusterScope: clusterScope ?? null,
            expiresAt,
          });
          log.info("machine-token.created", { id: row.id, name, role, serviceScope: serviceScope ?? null, clusterScope: clusterScope ?? null });
          // The cleartext is returned exactly once — it is never recoverable afterward.
          return status(201, { token, machineToken: tokenView(row) });
        } catch (e) {
          if (String((e as Error).message).includes("UNIQUE")) return status(409, { error: "a token with that name already exists" });
          throw e;
        }
      },
      { detail: { summary: "Create a machine token (returns the cleartext once)", tags: ["integrations"] } },
    )
    .delete(
      "/machine-tokens/:id",
      ({ params, status }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) return status(400, { error: "invalid id" });
        if (!deps.state.revokeMachineToken(id)) return status(404, { error: "not found or already revoked" });
        log.info("machine-token.revoked", { id });
        return { revoked: true };
      },
      { detail: { summary: "Revoke a machine token", tags: ["integrations"] } },
    )
    // ── webhooks management (admin only via role-map) ────────────────
    .get(
      "/webhooks",
      () => ({ items: deps.state.listWebhooks().map(webhookView) }),
      { detail: { summary: "List registry webhooks (HMAC secrets never returned)", tags: ["integrations"] } },
    )
    .post(
      "/webhooks",
      ({ body, status }) => {
        const parsed = CreateWebhookBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const { name, kind, serviceScope, clusterScope } = parsed.data;
        if (serviceScope && !deps.registry.get(serviceScope)) return status(400, { error: `service '${serviceScope}' not found` });
        if (clusterScope && !deps.clusters.get(clusterScope)) return status(400, { error: `cluster '${clusterScope}' not found` });
        const secret = generateWebhookSecret();
        try {
          const row = deps.state.createWebhook({
            name,
            secretId: generateSecretId(),
            kind,
            hmacSecret: secret,
            serviceScope: serviceScope ?? null,
            clusterScope: clusterScope ?? null,
          });
          log.info("webhook.created", { id: row.id, name: row.name, kind: row.kind, serviceScope: serviceScope ?? null, clusterScope: clusterScope ?? null });
          // secretId + hmacSecret returned once; the secret is never shown again.
          return status(201, { secret, webhook: webhookView(row) });
        } catch (e) {
          if (String((e as Error).message).includes("UNIQUE")) return status(409, { error: "a webhook with that name already exists" });
          throw e;
        }
      },
      { detail: { summary: "Create a registry webhook (returns the HMAC secret once)", tags: ["integrations"] } },
    )
    .delete(
      "/webhooks/:id",
      ({ params, status }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) return status(400, { error: "invalid id" });
        if (!deps.state.revokeWebhook(id)) return status(404, { error: "not found or already revoked" });
        log.info("webhook.revoked", { id });
        return { revoked: true };
      },
      { detail: { summary: "Revoke a registry webhook", tags: ["integrations"] } },
    )
    // ── webhook receiver (auth carve-out: HMAC + capability URL) ─────
    .post(
      "/webhooks/registry/:secretId",
      async ({ params, request, status }) => {
        if (overLimit(clientIp(request))) return status(429, { error: "too many requests" });
        // Cap the unauthenticated read before buffering the body.
        const len = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(len) && len > MAX_WEBHOOK_BODY) return status(413, { error: "payload too large" });
        const hook = deps.state.webhookBySecretId(params.secretId); // read-only — no write before auth
        if (!hook) return status(404, { error: "not found" });
        const raw = await request.text();
        if (raw.length > MAX_WEBHOOK_BODY) return status(413, { error: "payload too large" });
        const sig = request.headers.get("x-hub-signature-256");
        if (!verifyWebhookSignature(hook.hmac_secret, raw, sig)) {
          log.warn("webhook.bad-signature", { id: hook.id });
          return status(401, { error: "invalid signature" });
        }
        // Verified: record legitimate use (an unsigned probe never reaches this write).
        deps.state.touchWebhook(hook.id);
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          return status(400, { error: "invalid json" });
        }
        const pushes = parseRegistryPush(hook.kind as RegistryKind, parsedBody);
        const deployed: Array<{ service: string; tag: string; deploymentId: number }> = [];
        const skipped: Array<{ service: string; tag: string; reason: string }> = [];
        const inScope = (svc: { name: string; clusterId: string }) =>
          (!hook.service_scope || svc.name === hook.service_scope) && (!hook.cluster_scope || svc.clusterId === hook.cluster_scope);
        for (const push of pushes) {
          const target = normalizeImageRef(push.imageRef);
          const matches = deps.registry
            .list()
            .filter((s) => s.sourceType === "registry-pull" && s.enabled && normalizeImageRef(s.imageRef) === target && inScope(s));
          for (const svc of matches) {
            if (deps.state.serviceDegraded(svc.name)) {
              skipped.push({ service: svc.name, tag: push.tag, reason: "degraded" });
              continue;
            }
            // Atomic dedup+record+enqueue: a duplicate/concurrent push can't double-enqueue (TOCTOU).
            const id = deps.state.transaction(() => {
              if (deps.queue.hasActiveJob(svc.name, DEPLOY_JOB_KIND)) return null;
              const depId = deps.state.recordDeploymentStart(svc.name, push.tag);
              deps.queue.enqueue({ id: depId, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: svc.name, payload: { tag: push.tag } });
              return depId;
            });
            if (id === null) {
              skipped.push({ service: svc.name, tag: push.tag, reason: "deploy-already-active" });
              continue;
            }
            deployed.push({ service: svc.name, tag: push.tag, deploymentId: id });
          }
        }
        log.info("webhook.received", { id: hook.id, kind: hook.kind, pushes: pushes.length, deployed: deployed.length, skipped: skipped.length });
        return { deployed, skipped };
      },
      { detail: { summary: "Registry push webhook receiver (HMAC-verified)", tags: ["integrations"] } },
    );
};
