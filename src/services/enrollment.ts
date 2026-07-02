import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { State, EnrollmentTokenRow } from "../lib/state.ts";
import type { ClusterRegistry } from "./cluster-registry.ts";
import type { K8sPool } from "./k8s-pool.ts";
import type { CapabilityService } from "./capability-probe.ts";
import type { Clock } from "../lib/clock.ts";
import { ClusterModelSchema, ClusterRuntimeSchema, type ClusterModel, type ImageLoad } from "./model.ts";
import { hashEnrollmentToken } from "../lib/enrollment-token.ts";
import { recordAudit } from "../lib/audit.ts";
import { log } from "../lib/logger.ts";

const MAX_KUBECONFIG_BYTES = 256 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

export type SanitizeResult = { ok: true } | { ok: false; error: string };

type Mapping = Record<string, unknown>;

function isTruthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

function isMapping(v: unknown): v is Mapping {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function asNamedMap(entries: unknown[], childKey: string): Map<string, Mapping> {
  const out = new Map<string, Mapping>();
  for (const entry of entries) {
    if (!isMapping(entry) || typeof entry.name !== "string") continue;
    const child = entry[childKey];
    if (isMapping(child)) out.set(entry.name, child);
  }
  return out;
}

function hasStaticCredential(user: Mapping): boolean {
  if (typeof user.token === "string" && user.token.length > 0) return true;
  return typeof user["client-certificate-data"] === "string" && user["client-certificate-data"].length > 0 && typeof user["client-key-data"] === "string" && user["client-key-data"].length > 0;
}

function validateUser(user: Mapping): SanitizeResult {
  if ("exec" in user) return { ok: false, error: "exec credential plugins are not allowed" };
  if ("auth-provider" in user) return { ok: false, error: "auth-provider plugins are not allowed" };
  if (typeof user.tokenFile === "string") return { ok: false, error: "tokenFile (external file) is not allowed" };
  if (typeof user["client-key"] === "string") return { ok: false, error: "client-key file path is not allowed (use client-key-data)" };
  if (typeof user["client-certificate"] === "string") return { ok: false, error: "client-certificate file path is not allowed (use client-certificate-data)" };
  return { ok: true };
}

function validateCluster(cluster: Mapping): SanitizeResult {
  if ("proxy-url" in cluster) return { ok: false, error: "proxy-url is not allowed" };
  if (isTruthy(cluster["insecure-skip-tls-verify"])) return { ok: false, error: "insecure-skip-tls-verify is not allowed" };
  if (typeof cluster["certificate-authority"] === "string") return { ok: false, error: "certificate-authority file path is not allowed (use certificate-authority-data)" };
  const server = cluster.server;
  if (typeof server !== "string" || !server.startsWith("https://")) return { ok: false, error: "server must be https" };
  if (typeof cluster["certificate-authority-data"] !== "string" || cluster["certificate-authority-data"].length === 0) {
    return { ok: false, error: "cluster requires embedded certificate-authority-data" };
  }
  return { ok: true };
}

/**
 * Defense-in-depth validation of a worker-supplied kubeconfig before the master will trust it.
 * A kubeconfig hyper persists is consulted on EVERY `kubectl` call, so an attacker-controlled one is
 * RCE-/SSRF-equivalent. We **parse the YAML and walk the object graph** (a line/regex denylist is
 * unsafe — flow-style `user: {exec: {...}}` slips past anchored patterns), rejecting every construct
 * that would let the file run a binary, read host files, route credentials through a proxy, or skip
 * endpoint authentication. Only a self-contained, TLS-verified, static-credential kubeconfig (the k3s
 * default) is accepted. We reject rather than strip — a surprising input is a refused input.
 */
export function sanitizeKubeconfig(text: string): SanitizeResult {
  if (!text || text.trim().length === 0) return { ok: false, error: "empty kubeconfig" };
  if (text.length > MAX_KUBECONFIG_BYTES) return { ok: false, error: "kubeconfig too large" };

  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    return { ok: false, error: "invalid kubeconfig YAML" };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "kubeconfig is not a mapping" };
  const root = doc as Record<string, unknown>;
  const clusters = Array.isArray(root.clusters) ? root.clusters : [];
  const users = Array.isArray(root.users) ? root.users : [];
  const contexts = Array.isArray(root.contexts) ? root.contexts : [];

  // Every named user must carry only embedded, static credentials.
  for (const entry of users) {
    const u = isMapping(entry) ? entry.user : undefined;
    if (!isMapping(u)) continue;
    const checked = validateUser(u);
    if (!checked.ok) return checked;
  }

  // Every cluster must be a verifiable https endpoint, and none may proxy/skip-verify/file-ref.
  for (const entry of clusters) {
    const c = isMapping(entry) ? entry.cluster : undefined;
    if (!isMapping(c)) continue;
    const checked = validateCluster(c);
    if (!checked.ok) return checked;
  }

  const currentContext = root["current-context"];
  if (typeof currentContext !== "string" || currentContext.length === 0) return { ok: false, error: "current-context is required" };
  const contextEntry = contexts.find((entry) => isMapping(entry) && entry.name === currentContext);
  const context = isMapping(contextEntry) && isMapping(contextEntry.context) ? contextEntry.context : null;
  if (!context) return { ok: false, error: "current-context does not reference a declared context" };
  if (typeof context.cluster !== "string" || typeof context.user !== "string") {
    return { ok: false, error: "current-context must reference a cluster and user" };
  }
  const cluster = asNamedMap(clusters, "cluster").get(context.cluster);
  if (!cluster) return { ok: false, error: "current-context references an unknown cluster" };
  const clusterCheck = validateCluster(cluster);
  if (!clusterCheck.ok) return clusterCheck;
  const user = asNamedMap(users, "user").get(context.user);
  if (!user) return { ok: false, error: "current-context references an unknown user" };
  const userCheck = validateUser(user);
  if (!userCheck.ok) return userCheck;
  if (!hasStaticCredential(user)) return { ok: false, error: "current user requires embedded static credentials" };

  return { ok: true };
}

export const EnrollRequestSchema = z
  .object({
    token: z.string().min(1).max(256),
    kubeconfig: z.string().min(1).max(MAX_KUBECONFIG_BYTES),
    runtime: ClusterRuntimeSchema.optional(),
    nodeName: z.string().max(253).optional(),
  })
  .strip(); // ignore any extra fields a worker tries to smuggle in
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

/** Build the ClusterModel an enrolled worker becomes. Provenance fields are forced server-side. */
export function buildEnrolledCluster(
  token: EnrollmentTokenRow,
  kubeconfigPath: string,
  enrolledAt: string,
  runtimeOverride?: string,
): ClusterModel {
  return ClusterModelSchema.parse({
    id: token.cluster_id,
    name: token.cluster_name,
    kubeconfigPath,
    defaultNamespace: token.default_namespace,
    runtime: runtimeOverride ?? token.runtime,
    imageLoad: token.image_load as ImageLoad,
    origin: "enrolled",
    enrolledAt,
    enabled: true,
  });
}

export type EnrollOutcome =
  | { ok: true; cluster: ClusterModel }
  | { ok: false; status: 400 | 401 | 409; error: string };

export interface EnrollmentDeps {
  state: State;
  clusters: ClusterRegistry;
  pool: K8sPool;
  capabilities: CapabilityService;
  clock: Clock;
  authSecret: string;
  clustersDir: string;
}

/**
 * Orchestrates a worker self-registration: validate the kubeconfig, atomically consume the one-shot
 * token, persist the kubeconfig (exclusive temp file → atomic rename, mode 0600), register the cluster,
 * prime the pool + capability probe, and audit. Routes stay validation/formatting only.
 */
export class EnrollmentService {
  constructor(private readonly deps: EnrollmentDeps) {}

  async enroll(req: EnrollRequest): Promise<EnrollOutcome> {
    const { state, clusters, pool, capabilities, clock, authSecret, clustersDir } = this.deps;

    const clean = sanitizeKubeconfig(req.kubeconfig);
    if (!clean.ok) {
      this.audit("fail", "?", clean.error);
      return { ok: false, status: 400, error: clean.error };
    }

    const hash = hashEnrollmentToken(req.token, authSecret);
    // Peek (read-only) so a pre-detectable cluster-id collision doesn't burn the token.
    const peek = state.enrollmentTokenByHash(hash);
    if (!peek) {
      this.audit("fail", "?", "invalid or expired enrollment token");
      return { ok: false, status: 401, error: "invalid or expired enrollment token" };
    }
    if (!ID_RE.test(peek.cluster_id)) {
      this.audit("fail", peek.cluster_id, "invalid cluster id on token");
      return { ok: false, status: 400, error: "invalid cluster id on token" };
    }
    if (clusters.get(peek.cluster_id)) {
      this.audit("fail", peek.cluster_id, "cluster id already registered");
      return { ok: false, status: 409, error: `cluster '${peek.cluster_id}' already exists` };
    }

    // Consume atomically (single-use). A racing/replayed request loses here.
    const token = state.redeemEnrollmentToken(hash);
    if (!token) {
      this.audit("fail", peek.cluster_id, "enrollment token already used");
      return { ok: false, status: 401, error: "invalid or expired enrollment token" };
    }

    const enrolledAt = new Date(clock.now()).toISOString();
    let kubeconfigPath: string;
    try {
      kubeconfigPath = this.writeKubeconfig(token.cluster_id, req.kubeconfig);
    } catch (e) {
      this.audit("fail", token.cluster_id, `kubeconfig write failed: ${(e as Error).message}`);
      return { ok: false, status: 409, error: "could not persist kubeconfig" };
    }

    let cluster: ClusterModel;
    try {
      cluster = buildEnrolledCluster(token, kubeconfigPath, enrolledAt, req.runtime);
      clusters.create(cluster);
    } catch (e) {
      rmSync(kubeconfigPath, { force: true }); // don't leave an orphan credential on the disk
      this.audit("fail", token.cluster_id, `register failed: ${(e as Error).message}`);
      return { ok: false, status: 409, error: (e as Error).message };
    }

    pool.invalidate(cluster.id);
    await capabilities.refreshCluster(cluster.id).catch(() => {}); // probe never blocks enrollment success
    this.audit("ok", cluster.id, `enrolled ${cluster.runtime} cluster (node=${req.nodeName ?? "?"})`);
    log.info("cluster.enrolled", { id: cluster.id, runtime: cluster.runtime, imageLoad: cluster.imageLoad });
    return { ok: true, cluster };
  }

  /** Exclusive create (mode 0600) into a temp file, then atomic rename into a 0700 clusters dir. */
  private writeKubeconfig(clusterId: string, contents: string): string {
    mkdirSync(this.deps.clustersDir, { recursive: true, mode: 0o700 });
    const dest = join(this.deps.clustersDir, `${clusterId}.kubeconfig`);
    const tmp = join(this.deps.clustersDir, `.${clusterId}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
      renameSync(tmp, dest);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return dest;
  }

  /** Carve-out requests have no authenticated principal, so the HTTP audit hook can't cover them —
   *  record explicitly here. The token + kubeconfig body are never included. */
  private audit(result: "ok" | "fail", clusterId: string, message: string): void {
    recordAudit(
      this.deps.state,
      { actor: "enroll", action: "cluster.enroll", resourceKind: "cluster", resourceId: clusterId, result, message },
      this.deps.clock.now(),
    );
  }
}
