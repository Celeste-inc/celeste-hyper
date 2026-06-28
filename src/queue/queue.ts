import type { Database } from "bun:sqlite";
import type { State } from "../lib/state.ts";
import { type Clock, realClock } from "../lib/clock.ts";
import { acquireLock, renewLock, releaseLock, type Lock } from "../lib/lock.ts";

export type JobState = "pending" | "running" | "done" | "failed" | "dead";

export interface JobRow {
  id: number;
  kind: string;
  resource_kind: string;
  resource_id: string;
  payload: string;
  state: JobState;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
  lease_holder: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  fencing_token: number;
}

export interface EnqueueInput {
  kind: string;
  resourceKind: string;
  resourceId: string;
  payload?: unknown;
  maxAttempts?: number;
  /** Explicit id to preserve the deploy 1:1 invariant (job id == deployment id). */
  id?: number;
  /** Delay before the job becomes claimable (e.g. the auto-rollback grace window). */
  delayMs?: number;
}

export const LEASE_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 60_000;

/** Exponential backoff: min(60s, 5s * 2^attempts). */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);
}

/**
 * Persistent job queue over `bun:sqlite`. Data-access sibling of `State`/`lock.ts`: it owns the
 * `jobs` table SQL and the per-resource lock used for fencing. All `.run`/`.get` calls are
 * synchronous, so a single `claim` statement serializes concurrent claimers within a process;
 * the per-service lock + monotonic fencing token extend that across processes.
 */
export class Queue {
  private readonly db: Database;

  constructor(
    private readonly state: State,
    private readonly clock: Clock = realClock(),
  ) {
    this.db = state.database;
  }

  private iso(ms: number = this.clock.now()): string {
    return new Date(ms).toISOString();
  }

  enqueue(input: EnqueueInput): number {
    const now = this.iso();
    const dueAt = this.iso(this.clock.now() + (input.delayMs ?? 0));
    const payload = JSON.stringify(input.payload ?? {});
    const max = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (input.id !== undefined) {
      this.db.run(
        "INSERT INTO jobs (id, kind, resource_kind, resource_id, payload, state, attempts, max_attempts, next_attempt_at, created_at, updated_at, fencing_token) " +
          "VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, 0)",
        [input.id, input.kind, input.resourceKind, input.resourceId, payload, max, dueAt, now, now],
      );
      return input.id;
    }
    const r = this.db
      .query(
        "INSERT INTO jobs (kind, resource_kind, resource_id, payload, state, attempts, max_attempts, next_attempt_at, created_at, updated_at, fencing_token) " +
          "VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, 0) RETURNING id",
      )
      .get(input.kind, input.resourceKind, input.resourceId, payload, max, dueAt, now, now) as { id: number };
    return r.id;
  }

  /** Cancel a still-pending job (e.g. the auto-rollback grace-window cancel). Returns whether it was removed. */
  cancelPending(id: number): boolean {
    return this.db.run("DELETE FROM jobs WHERE id = ? AND state = 'pending'", [id]).changes > 0;
  }

  /** Atomically claim the oldest due (`pending`, `next_attempt_at <= now`) job. One SQL statement. */
  claim(holder: string, leaseMs: number = LEASE_MS): JobRow | null {
    const now = this.clock.now();
    const nowIso = this.iso(now);
    const row = this.db
      .query(
        "UPDATE jobs SET state='running', lease_until=?, lease_holder=?, attempts=attempts+1, updated_at=? " +
          "WHERE id = (SELECT id FROM jobs WHERE state='pending' AND next_attempt_at <= ? ORDER BY id LIMIT 1) RETURNING *",
      )
      .get(this.iso(now + leaseMs), holder, nowIso, nowIso) as JobRow | undefined;
    return row ?? null;
  }

  getJob(id: number): JobRow | null {
    return (this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null) ?? null;
  }

  setFencingToken(id: number, token: number): void {
    this.db.run("UPDATE jobs SET fencing_token=?, updated_at=? WHERE id=?", [token, this.iso(), id]);
  }

  /** Extend a running job's lease (heartbeat). No-op if the job is no longer running. */
  heartbeat(id: number, leaseMs: number = LEASE_MS): void {
    this.db.run("UPDATE jobs SET lease_until=?, updated_at=? WHERE id=? AND state='running'", [
      this.iso(this.clock.now() + leaseMs),
      this.iso(),
      id,
    ]);
  }

  // Terminal writes are guarded by `state='running'` (and the lease holder, when supplied) so a
  // zombie worker whose job was already reaped+reclaimed by another holder cannot clobber it.
  private ownerGuard(holder?: string): { sql: string; params: Array<string | number> } {
    return holder !== undefined
      ? { sql: " AND state='running' AND lease_holder=?", params: [holder] }
      : { sql: " AND state='running'", params: [] };
  }

  complete(id: number, holder?: string): void {
    const g = this.ownerGuard(holder);
    this.db.run(
      `UPDATE jobs SET state='done', lease_until=NULL, lease_holder=NULL, last_error=NULL, updated_at=? WHERE id=?${g.sql}`,
      [this.iso(), id, ...g.params],
    );
  }

  /**
   * Record a failed attempt (handler error): retry with exponential backoff if attempts remain,
   * else terminal `failed`. (Crash/lease-loss exhaustion goes to `dead` via `reapExpiredLeases`,
   * so the two terminal states distinguish application failure from worker death.)
   */
  fail(id: number, error: string, holder?: string): "pending" | "failed" {
    const job = this.getJob(id);
    if (!job) return "failed";
    const now = this.clock.now();
    const g = this.ownerGuard(holder);
    if (job.attempts >= job.max_attempts) {
      this.db.run(
        `UPDATE jobs SET state='failed', lease_until=NULL, lease_holder=NULL, last_error=?, updated_at=? WHERE id=?${g.sql}`,
        [error, this.iso(now), id, ...g.params],
      );
      return "failed";
    }
    this.db.run(
      `UPDATE jobs SET state='pending', lease_until=NULL, lease_holder=NULL, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?${g.sql}`,
      [error, this.iso(now + backoffMs(job.attempts)), this.iso(now), id, ...g.params],
    );
    return "pending";
  }

  /**
   * Make the current attempt terminal: collapse max_attempts to the attempts already burned so the
   * next `fail()` records `failed` instead of scheduling a retry. Used when retrying would be
   * actively harmful (a health-gate failure that triggered an auto-rollback — re-applying the bad
   * image would fight the rollback for the fencing token).
   */
  noRetry(id: number): void {
    this.db.run("UPDATE jobs SET max_attempts = attempts, updated_at=? WHERE id=?", [this.iso(), id]);
  }

  /**
   * The oldest still-pending job for this resource+kind, or null. With `autoOnly`, restricts to jobs
   * whose payload has `auto:true` (the grace-delayed auto-rollback) so the auto-rollback status/cancel
   * endpoints never report or cancel an operator's manual rollback.
   */
  pendingJob(resourceId: string, kind: string, autoOnly = false): JobRow | null {
    const auto = autoOnly ? " AND json_extract(payload, '$.auto') = 1" : "";
    return (
      (this.db
        .query(`SELECT * FROM jobs WHERE resource_id=? AND kind=? AND state='pending'${auto} ORDER BY id LIMIT 1`)
        .get(resourceId, kind) as JobRow | null) ?? null
    );
  }

  /** True if a job for this resource+kind is already queued or running (dedup guard for the poller). */
  hasActiveJob(resourceId: string, kind: string): boolean {
    const r = this.db
      .query("SELECT 1 FROM jobs WHERE resource_id=? AND kind=? AND state IN ('pending','running') LIMIT 1")
      .get(resourceId, kind);
    return r !== null && r !== undefined;
  }

  /**
   * Outstanding (not-yet-terminal) jobs across all resources — the queue depth surfaced by /api/health.
   * Two single-`=` subqueries (not `state IN (...)`): both stay COVERING-INDEX seeks on `idx_jobs_claimable`
   * even after `ANALYZE`, where the `IN` form regresses to a full scan over the never-pruned `jobs` table.
   */
  outstandingCount(): number {
    const r = this.db
      .query("SELECT (SELECT count(*) FROM jobs WHERE state='pending') + (SELECT count(*) FROM jobs WHERE state='running') AS c")
      .get() as { c: number };
    return r.c;
  }

  /** Return a claimed job to `pending` immediately without counting the attempt (lock contention). */
  deferClaim(id: number, delayMs = 0): void {
    const now = this.clock.now();
    this.db.run(
      "UPDATE jobs SET state='pending', attempts=attempts-1, lease_until=NULL, lease_holder=NULL, next_attempt_at=?, updated_at=? WHERE id=?",
      [this.iso(now + delayMs), this.iso(now), id],
    );
  }

  /**
   * Requeue running jobs whose lease has expired (the worker died). Re-enqueued immediately
   * (lease loss is not an application error); attempts already counted at claim time bound the
   * loop, so a job that has exhausted its attempts moves to `dead`. Returns the number reaped.
   */
  reapExpiredLeases(): number {
    const nowIso = this.iso(this.clock.now());
    // Two set-based, state-guarded UPDATEs (no SELECT-then-loop): each only touches rows that are
    // STILL `running` and expired, so a concurrent heartbeat/complete between read and write can't
    // be clobbered. Exhausted → `dead`; otherwise requeued immediately (lease loss ≠ app error).
    const dead = this.db.run(
      "UPDATE jobs SET state='dead', lease_until=NULL, lease_holder=NULL, last_error='lease expired', updated_at=? " +
        "WHERE state='running' AND lease_until IS NOT NULL AND lease_until <= ? AND attempts >= max_attempts",
      [nowIso, nowIso],
    );
    const requeued = this.db.run(
      "UPDATE jobs SET state='pending', lease_until=NULL, lease_holder=NULL, last_error='lease expired', next_attempt_at=?, updated_at=? " +
        "WHERE state='running' AND lease_until IS NOT NULL AND lease_until <= ? AND attempts < max_attempts",
      [nowIso, nowIso, nowIso],
    );
    return dead.changes + requeued.changes;
  }

  // ── per-resource lock (fencing) ────────────────────────────────────
  private resourceKey(resourceId: string): string {
    return `job:${resourceId}`;
  }

  acquireLock(resourceId: string, holder: string, ttlMs: number = LEASE_MS): Lock | null {
    return acquireLock(this.db, this.resourceKey(resourceId), holder, ttlMs, this.clock);
  }

  renewLock(lock: Lock, ttlMs: number = LEASE_MS): boolean {
    return renewLock(this.db, lock.resource, lock.holder, lock.token, ttlMs, this.clock);
  }

  releaseLock(lock: Lock): void {
    releaseLock(this.db, lock.resource, lock.holder);
  }
}
