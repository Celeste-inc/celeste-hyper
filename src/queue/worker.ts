import { type Clock, realClock, type Timer } from "../lib/clock.ts";
import type { Lock } from "../lib/lock.ts";
import { Queue, LEASE_MS, type JobRow } from "./queue.ts";
import { log } from "../lib/logger.ts";

export type JobHandler = (job: JobRow) => Promise<void>;

export interface WorkerOpts {
  queue: Queue;
  /** Map of `job.kind` → handler. */
  handlers: Record<string, JobHandler>;
  clock?: Clock;
  /** Lease-holder identity; distinct per process so N processes can share the queue later. */
  holder?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  /** Idle poll interval when no job is claimable. */
  pollMs?: number;
  shutdownGraceMs?: number;
  /** Audit sink (P2.1): called on each terminal job outcome, attributed to `system`. */
  audit?: (job: JobRow, result: "ok" | "fail", message?: string) => void;
}

const HEARTBEAT_MS = 10_000;
const POLL_MS = 1_000;
const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Single-threaded job worker: one job at a time. `start()` runs a self-rescheduling loop; each
 * iteration reaps expired leases, atomically claims the next due job, takes the per-resource lock
 * (recording its fencing token), runs the kind's handler under a lease heartbeat, and marks the
 * job done/failed. `stop()` stops claiming and waits up to the grace period for the running job.
 */
export class Worker {
  private readonly queue: Queue;
  private readonly handlers: Record<string, JobHandler>;
  private readonly clock: Clock;
  private readonly holder: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly shutdownGraceMs: number;
  private readonly audit?: (job: JobRow, result: "ok" | "fail", message?: string) => void;

  private stopping = false;
  private loopTimer: Timer | null = null;
  private inflight: Promise<void> | null = null;

  constructor(opts: WorkerOpts) {
    this.queue = opts.queue;
    this.handlers = opts.handlers;
    this.clock = opts.clock ?? realClock();
    this.holder = opts.holder ?? `worker-${process.pid}`;
    this.leaseMs = opts.leaseMs ?? LEASE_MS;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.audit = opts.audit;
  }

  start(): void {
    if (this.loopTimer !== null) return; // already running — never run two loops
    this.stopping = false;
    const loop = async () => {
      if (this.stopping) return;
      let ran = false;
      try {
        ran = await this.tick();
      } catch (e) {
        log.error("worker.loop_error", { error: (e as Error).message });
      }
      if (!this.stopping) this.loopTimer = this.clock.setTimeout(loop, ran ? 0 : this.pollMs);
    };
    this.loopTimer = this.clock.setTimeout(loop, 0);
  }

  /**
   * Stop claiming and wait (bounded by the grace period) for the running job. Returns whether the
   * job drained cleanly — `false` means the grace elapsed with the job still running, so the caller
   * must NOT close the DB under it (the job will be reaped/recovered on the next boot).
   */
  async stop(): Promise<boolean> {
    this.stopping = true;
    if (this.loopTimer !== null) {
      this.clock.clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    const current = this.inflight;
    if (!current) return true;
    let timedOut = false;
    let graceTimer: Timer | null = null;
    const grace = new Promise<void>((resolve) => {
      graceTimer = this.clock.setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.shutdownGraceMs);
    });
    await Promise.race([current, grace]);
    if (graceTimer !== null) this.clock.clearTimeout(graceTimer);
    return !timedOut;
  }

  /** Claim and fully process at most one job. Returns whether a job ran. */
  async tick(): Promise<boolean> {
    if (this.stopping) return false;
    this.queue.reapExpiredLeases();
    const job = this.queue.claim(this.holder, this.leaseMs);
    if (!job) return false;

    const lock = this.queue.acquireLock(job.resource_id, this.holder, this.leaseMs);
    if (!lock) {
      // Another holder owns the resource lock (cross-process). Return the job without burning an
      // attempt; it becomes claimable again after a short delay.
      this.queue.deferClaim(job.id, this.pollMs);
      return false;
    }
    this.queue.setFencingToken(job.id, lock.token);
    job.fencing_token = lock.token;

    const heartbeat = this.startHeartbeat(job.id, lock);
    this.inflight = (async () => {
      try {
        const handler = this.handlers[job.kind];
        if (!handler) throw new Error(`no handler registered for kind '${job.kind}'`);
        await handler(job);
        this.queue.complete(job.id, this.holder);
        log.info("worker.job_done", { id: job.id, kind: job.kind });
        this.recordAudit(job, "ok");
      } catch (e) {
        const msg = (e as Error).message;
        const outcome = this.queue.fail(job.id, msg, this.holder);
        log.warn("worker.job_failed", { id: job.id, kind: job.kind, outcome, error: msg });
        if (outcome === "failed") this.recordAudit(job, "fail", msg); // only the terminal failure, not each retry
      } finally {
        this.stopHeartbeat(heartbeat);
        this.queue.releaseLock(lock);
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
    return true;
  }

  /** Best-effort audit of a terminal job outcome; never lets an audit error escape into the loop. */
  private recordAudit(job: JobRow, result: "ok" | "fail", message?: string): void {
    if (!this.audit) return;
    try {
      this.audit(job, result, message);
    } catch (e) {
      log.error("worker.audit_failed", { id: job.id, error: (e as Error).message });
    }
  }

  private startHeartbeat(jobId: number, lock: Lock): { timer: Timer; stopped: boolean } {
    // `stopped` guards the macrotask/microtask race: a timer can fire (queuing `beat`) just as the
    // job's `finally` (a microtask) runs `stopHeartbeat`. Microtasks drain first, so without this
    // flag `beat` would run afterward and reschedule a timer that nothing ever clears.
    const h = { timer: 0 as Timer, stopped: false };
    const beat = () => {
      if (h.stopped) return;
      this.queue.heartbeat(jobId, this.leaseMs);
      if (!this.queue.renewLock(lock, this.leaseMs)) log.warn("worker.lock_lost", { id: jobId });
      if (h.stopped) return;
      h.timer = this.clock.setTimeout(beat, this.heartbeatMs);
    };
    h.timer = this.clock.setTimeout(beat, this.heartbeatMs);
    return h;
  }

  private stopHeartbeat(h: { timer: Timer; stopped: boolean }): void {
    h.stopped = true;
    this.clock.clearTimeout(h.timer);
  }
}
