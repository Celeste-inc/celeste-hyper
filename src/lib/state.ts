import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.ts";
import { applyMigrations } from "./migrations.ts";
import { MIGRATIONS, BINARY_SCHEMA_VERSION } from "./migrations/index.ts";
import { type Clock, realClock } from "./clock.ts";
import { fencedSetCurrent } from "./lock.ts";
import type { ServiceModel, ClusterModel } from "../services/model.ts";

export type DeploymentStatus = "pending" | "downloading" | "loading" | "applying" | "done" | "failed" | "cancelled";

export type DeploymentAction = "deploy" | "rollback";

export interface DeploymentRow {
  id: number;
  service: string;
  tag: string;
  status: DeploymentStatus;
  message: string | null;
  started_at: string;
  finished_at: string | null;
  action: DeploymentAction;
  health_gate_result: string | null;
}

export interface CurrentRow {
  service: string;
  tag: string;
  deployed_at: string;
}

interface ServiceRow {
  name: string;
  spec: string;
  created_at: string;
  updated_at: string;
}

interface ClusterRow {
  id: string;
  spec: string;
  created_at: string;
  updated_at: string;
}

export type Role = "admin" | "operator" | "viewer";

export interface UserRow {
  username: string;
  password_hash: string;
  role: Role;
  created_at: string;
  updated_at: string;
  must_change_password: number;
}

export interface MachineTokenRow {
  id: number;
  name: string;
  hash_sha256: string;
  role: Role;
  service_scope: string | null;
  cluster_scope: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface WebhookRow {
  id: number;
  name: string;
  secret_id: string;
  kind: string;
  hmac_secret: string;
  service_scope: string | null;
  cluster_scope: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export class State {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(dbPath: string, clock: Clock = realClock()) {
    this.clock = clock;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    applyMigrations(this.db, MIGRATIONS, BINARY_SCHEMA_VERSION, { dbPath, now: () => this.clock.now() });
    log.info("state.opened", { path: dbPath });
  }

  /** Raw connection for the queue/lock data-access layer (`queue.ts`, `lock.ts`), which own their
   *  own table SQL the way `lock.ts` already does. Application code uses the typed methods below. */
  get database(): Database {
    return this.db;
  }

  recordDeploymentStart(service: string, tag: string, action: DeploymentAction = "deploy"): number {
    const now = new Date(this.clock.now()).toISOString();
    const r = this.db.query(
      "INSERT INTO deployments (service, tag, status, started_at, action) VALUES (?, ?, 'pending', ?, ?) RETURNING id",
    ).get(service, tag, now, action) as { id: number };
    return r.id;
  }

  // ── degraded services (P1.9 single-shot auto-rollback safety) ──────
  setServiceDegraded(service: string, reason: string): void {
    const now = new Date(this.clock.now()).toISOString();
    this.db.run(
      "INSERT INTO service_degraded (service, reason, at) VALUES (?, ?, ?) ON CONFLICT(service) DO UPDATE SET reason = excluded.reason, at = excluded.at",
      [service, reason, now],
    );
  }

  clearServiceDegraded(service: string): void {
    this.db.run("DELETE FROM service_degraded WHERE service = ?", [service]);
  }

  serviceDegraded(service: string): { reason: string; at: string } | null {
    const r = this.db.query("SELECT reason, at FROM service_degraded WHERE service = ?").get(service) as
      | { reason: string; at: string }
      | null;
    return r ?? null;
  }

  /** Record the steady-state health-gate outcome (JSON) for a deployment (P1.8). */
  setHealthGateResult(id: number, resultJson: string): void {
    this.db.run("UPDATE deployments SET health_gate_result = ? WHERE id = ?", [resultJson, id]);
  }

  /** Most recent successful tag for a service other than `currentTag` (rollback Source A: hyper history). */
  previousDoneTag(service: string, currentTag: string): string | null {
    const r = this.db
      .query(
        "SELECT tag FROM deployments WHERE service = ? AND status = 'done' AND tag <> ? ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get(service, currentTag) as { tag: string } | null;
    return r?.tag ?? null;
  }

  /** Create a `pending` deployment row with an explicit id (= job id), idempotently. Lets the
   *  queue worker self-create the row in isolation while the enqueuer's row (same id) wins first. */
  ensureDeploymentRow(id: number, service: string, tag: string, action: DeploymentAction = "deploy"): void {
    const now = new Date(this.clock.now()).toISOString();
    this.db.run(
      "INSERT OR IGNORE INTO deployments (id, service, tag, status, started_at, action) VALUES (?, ?, ?, 'pending', ?, ?)",
      [id, service, tag, now, action],
    );
  }

  /** Fencing-gated `current_deployment` write (stale tokens are no-ops). Used by the P0.7 worker. */
  setCurrentFenced(service: string, tag: string, token: number): boolean {
    return fencedSetCurrent(this.db, service, tag, token, this.clock);
  }

  /**
   * Commit a successful rollback atomically: the fenced current-tag write, the deployment row's
   * terminal status, and clearing any degraded mark land in one transaction. A crash mid-finalize
   * can't leave the service flagged degraded after the deployment already shows `done` (P1.9).
   */
  finalizeRollback(service: string, tag: string, token: number, deploymentId: number, message: string): void {
    this.db.transaction(() => {
      this.setCurrentFenced(service, tag, token);
      this.updateDeployment(deploymentId, "done", message);
      this.clearServiceDegraded(service);
    })();
  }

  updateDeployment(id: number, status: DeploymentStatus, message?: string): void {
    const finished =
      status === "done" || status === "failed" || status === "cancelled"
        ? new Date(this.clock.now()).toISOString()
        : null;
    this.db.run(
      "UPDATE deployments SET status = ?, message = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?",
      [status, message ?? null, finished, id],
    );
  }

  setCurrent(service: string, tag: string): void {
    this.db.run(
      "INSERT INTO current_deployment (service, tag, deployed_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(service) DO UPDATE SET tag = excluded.tag, deployed_at = excluded.deployed_at",
      [service, tag, new Date(this.clock.now()).toISOString()],
    );
  }

  getCurrent(service: string): CurrentRow | null {
    const r = this.db.query("SELECT * FROM current_deployment WHERE service = ?").get(service);
    return (r as CurrentRow | null) ?? null;
  }

  listCurrent(): CurrentRow[] {
    return this.db.query("SELECT * FROM current_deployment").all() as CurrentRow[];
  }

  deploymentById(id: number): DeploymentRow | null {
    const r = this.db.query("SELECT * FROM deployments WHERE id = ?").get(id) as DeploymentRow | null;
    return r ?? null;
  }

  recentDeployments(service: string, limit = 20): DeploymentRow[] {
    return this.db
      .query("SELECT * FROM deployments WHERE service = ? ORDER BY started_at DESC LIMIT ?")
      .all(service, limit) as DeploymentRow[];
  }

  listServices(): ServiceModel[] {
    const rows = this.db.query("SELECT * FROM services ORDER BY name").all() as ServiceRow[];
    return rows.map((r) => JSON.parse(r.spec) as ServiceModel);
  }

  getService(name: string): ServiceModel | null {
    const r = this.db.query("SELECT * FROM services WHERE name = ?").get(name) as ServiceRow | null;
    return r ? (JSON.parse(r.spec) as ServiceModel) : null;
  }

  upsertService(svc: ServiceModel): void {
    const now = new Date(this.clock.now()).toISOString();
    const spec = JSON.stringify(svc);
    this.db.run(
      "INSERT INTO services (name, spec, created_at, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at",
      [svc.name, spec, now, now],
    );
  }

  deleteService(name: string): boolean {
    const r = this.db.run("DELETE FROM services WHERE name = ?", [name]);
    return r.changes > 0;
  }

  countServices(): number {
    const r = this.db.query("SELECT COUNT(*) as n FROM services").get() as { n: number };
    return r.n;
  }

  listClusters(): ClusterModel[] {
    const rows = this.db.query("SELECT * FROM clusters ORDER BY id").all() as ClusterRow[];
    return rows.map((r) => JSON.parse(r.spec) as ClusterModel);
  }

  getCluster(id: string): ClusterModel | null {
    const r = this.db.query("SELECT * FROM clusters WHERE id = ?").get(id) as ClusterRow | null;
    return r ? (JSON.parse(r.spec) as ClusterModel) : null;
  }

  upsertCluster(cluster: ClusterModel): void {
    const now = new Date(this.clock.now()).toISOString();
    const spec = JSON.stringify(cluster);
    this.db.run(
      "INSERT INTO clusters (id, spec, created_at, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at",
      [cluster.id, spec, now, now],
    );
  }

  deleteCluster(id: string): boolean {
    const r = this.db.run("DELETE FROM clusters WHERE id = ?", [id]);
    return r.changes > 0;
  }

  countClusters(): number {
    const r = this.db.query("SELECT COUNT(*) as n FROM clusters").get() as { n: number };
    return r.n;
  }

  countServicesByCluster(clusterId: string): number {
    const all = this.listServices();
    return all.filter((s) => s.clusterId === clusterId).length;
  }

  // ── users ──────────────────────────────────────────────────────────
  countUsers(): number {
    const r = this.db.query("SELECT COUNT(*) as n FROM users").get() as { n: number };
    return r.n;
  }

  getUser(username: string): UserRow | null {
    return (this.db.query("SELECT * FROM users WHERE username = ?").get(username) as UserRow | null) ?? null;
  }

  createUser(username: string, passwordHash: string, role: Role, mustChangePassword = false): UserRow {
    const now = new Date(this.clock.now()).toISOString();
    this.db.run(
      "INSERT INTO users (username, password_hash, role, created_at, updated_at, must_change_password) VALUES (?, ?, ?, ?, ?, ?)",
      [username, passwordHash, role, now, now, mustChangePassword ? 1 : 0],
    );
    return { username, password_hash: passwordHash, role, created_at: now, updated_at: now, must_change_password: mustChangePassword ? 1 : 0 };
  }

  setUserPassword(username: string, passwordHash: string, mustChangePassword = false): boolean {
    const now = new Date(this.clock.now()).toISOString();
    const r = this.db.run(
      "UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE username = ?",
      [passwordHash, mustChangePassword ? 1 : 0, now, username],
    );
    return r.changes > 0;
  }

  // ── meta (k/v for the persisted JWT secret etc.) ───────────────────
  getMeta(key: string): string | null {
    const r = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  // ── one-shot log-stream tokens (P0.6) ──────────────────────────────
  createLogToken(token: string, service: string, ttlMs: number): number {
    const now = this.clock.now();
    const expiresAt = now + ttlMs;
    // Opportunistic GC: these are 60s single-use tokens; never let dead rows accumulate.
    this.db.run("DELETE FROM log_tokens WHERE expires_at <= ?", [now]);
    this.db.run("INSERT INTO log_tokens (token, service, expires_at, used_at) VALUES (?, ?, ?, NULL)", [
      token,
      service,
      expiresAt,
    ]);
    return expiresAt;
  }

  /** Redeem a log token: succeeds once, only if unexpired, unused, and scoped to `service`. */
  redeemLogToken(token: string, service: string): boolean {
    const now = this.clock.now();
    const r = this.db.run(
      "UPDATE log_tokens SET used_at = ? WHERE token = ? AND service = ? AND used_at IS NULL AND expires_at > ?",
      [now, token, service, now],
    );
    return r.changes > 0;
  }

  // ── one-shot exec (terminal) tokens (P3.2) ─────────────────────────
  createExecToken(token: string, service: string, pod: string, container: string, ttlMs: number): number {
    const now = this.clock.now();
    const expiresAt = now + ttlMs;
    this.db.run("DELETE FROM exec_tokens WHERE expires_at <= ?", [now]); // opportunistic GC
    this.db.run("INSERT INTO exec_tokens (token, service, pod, container, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)", [
      token,
      service,
      pod,
      container,
      expiresAt,
    ]);
    return expiresAt;
  }

  /**
   * Redeem an exec token: succeeds once, only if unexpired/unused and scoped to `service`. Returns the
   * bound `{ pod, container }` so the WS execs exactly what the operator was authorized for (the WS's
   * `:name`/`?token` can't widen the target).
   */
  redeemExecToken(token: string, service: string): { pod: string; container: string } | null {
    const now = this.clock.now();
    const row = this.db
      .query("SELECT pod, container FROM exec_tokens WHERE token = ? AND service = ? AND used_at IS NULL AND expires_at > ?")
      .get(token, service, now) as { pod: string; container: string } | null;
    if (!row) return null;
    const r = this.db.run("UPDATE exec_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL", [now, token]);
    return r.changes > 0 ? row : null; // lost the single-use race
  }

  // ── cluster capability cache (P0.8) ────────────────────────────────
  /** Store the cluster-level capability map (opaque JSON) + the probed apiserver version (CC.5) for a cluster. */
  setClusterCapabilities(clusterId: string, capabilitiesJson: string, checkedAt: string, serverVersion: string | null = null): void {
    this.db.run(
      "INSERT INTO cluster_capabilities (cluster_id, capabilities, last_checked_at, server_version) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(cluster_id) DO UPDATE SET capabilities = excluded.capabilities, last_checked_at = excluded.last_checked_at, server_version = excluded.server_version",
      [clusterId, capabilitiesJson, checkedAt, serverVersion],
    );
  }

  getClusterCapabilities(clusterId: string): { capabilities: string; last_checked_at: string; server_version: string | null } | null {
    const r = this.db
      .query("SELECT capabilities, last_checked_at, server_version FROM cluster_capabilities WHERE cluster_id = ?")
      .get(clusterId) as { capabilities: string; last_checked_at: string; server_version: string | null } | null;
    return r ?? null;
  }

  deleteClusterCapabilities(clusterId: string): void {
    this.db.run("DELETE FROM cluster_capabilities WHERE cluster_id = ?", [clusterId]);
  }

  // ── workload classification overrides (P1.5) ───────────────────────
  setWorkloadOverride(clusterId: string, namespace: string, kind: string, name: string, category: string): void {
    const now = new Date(this.clock.now()).toISOString();
    this.db.run(
      "INSERT INTO workload_overrides (cluster_id, namespace, kind, name, category, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(cluster_id, namespace, kind, name) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at",
      [clusterId, namespace, kind, name, category, now],
    );
  }

  /** All overrides for a cluster as a Map keyed by `namespace/kind/name`. */
  workloadOverrides(clusterId: string): Map<string, string> {
    const rows = this.db
      .query("SELECT namespace, kind, name, category FROM workload_overrides WHERE cluster_id = ?")
      .all(clusterId) as Array<{ namespace: string; kind: string; name: string; category: string }>;
    return new Map(rows.map((r) => [`${r.namespace}/${r.kind}/${r.name}`, r.category]));
  }

  // ── machine tokens (P1.10) ─────────────────────────────────────────
  createMachineToken(input: {
    name: string;
    hashSha256: string;
    role: Role;
    serviceScope: string | null;
    clusterScope: string | null;
    expiresAt: string | null;
  }): MachineTokenRow {
    const now = new Date(this.clock.now()).toISOString();
    const r = this.db
      .query(
        "INSERT INTO machine_tokens (name, hash_sha256, role, service_scope, cluster_scope, created_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(input.name, input.hashSha256, input.role, input.serviceScope, input.clusterScope, now, input.expiresAt) as MachineTokenRow;
    return r;
  }

  listMachineTokens(): MachineTokenRow[] {
    return this.db.query("SELECT * FROM machine_tokens ORDER BY id").all() as MachineTokenRow[];
  }

  /**
   * Resolve an active (not revoked, not expired) token by its stored hash. Records last_used_at, but
   * only when it is stale (> 5 min) so the auth hot-path doesn't take the single WAL writer on every
   * request during a CI burst.
   */
  machineTokenByHash(hash: string): MachineTokenRow | null {
    const now = this.clock.now();
    const nowIso = new Date(now).toISOString();
    const r = this.db
      .query(
        "SELECT * FROM machine_tokens WHERE hash_sha256 = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(hash, nowIso) as MachineTokenRow | null;
    if (r) {
      const staleBefore = new Date(now - 5 * 60_000).toISOString();
      this.db.run("UPDATE machine_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)", [
        nowIso,
        r.id,
        staleBefore,
      ]);
    }
    return r ?? null;
  }

  /** Revoke a token (idempotent — only the first revoke sets the timestamp). Returns whether it flipped. */
  revokeMachineToken(id: number): boolean {
    const now = new Date(this.clock.now()).toISOString();
    return this.db.run("UPDATE machine_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]).changes > 0;
  }

  // ── registry webhooks (P1.10) ──────────────────────────────────────
  createWebhook(input: {
    name: string;
    secretId: string;
    kind: string;
    hmacSecret: string;
    serviceScope: string | null;
    clusterScope: string | null;
  }): WebhookRow {
    const now = new Date(this.clock.now()).toISOString();
    const r = this.db
      .query(
        "INSERT INTO webhooks (name, secret_id, kind, hmac_secret, service_scope, cluster_scope, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(input.name, input.secretId, input.kind, input.hmacSecret, input.serviceScope, input.clusterScope, now) as WebhookRow;
    return r;
  }

  listWebhooks(): WebhookRow[] {
    return this.db.query("SELECT * FROM webhooks ORDER BY id").all() as WebhookRow[];
  }

  /** Resolve an active webhook by its URL capability segment. Read-only (no side effect) — the
   *  caller records use via `touchWebhook` only AFTER the HMAC signature verifies, so an unsigned
   *  probe with a leaked secretId can't drive a write storm on the carve-out endpoint. */
  webhookBySecretId(secretId: string): WebhookRow | null {
    const r = this.db.query("SELECT * FROM webhooks WHERE secret_id = ? AND revoked_at IS NULL").get(secretId) as
      | WebhookRow
      | null;
    return r ?? null;
  }

  /** Record that a webhook was legitimately used (post-signature-verification). */
  touchWebhook(id: number): void {
    this.db.run("UPDATE webhooks SET last_used_at = ? WHERE id = ?", [new Date(this.clock.now()).toISOString(), id]);
  }

  /** Run a function inside a single transaction (used to make a check-then-enqueue atomic). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  revokeWebhook(id: number): boolean {
    const now = new Date(this.clock.now()).toISOString();
    return this.db.run("UPDATE webhooks SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
