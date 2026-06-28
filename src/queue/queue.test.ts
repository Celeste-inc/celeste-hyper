import { describe, it, expect } from "bun:test";
import { State } from "../lib/state.ts";
import { fakeClock } from "../lib/clock.ts";
import { Queue, backoffMs } from "./queue.ts";

function setup(initialMs = 0) {
  const clock = fakeClock(initialMs);
  const state = new State(":memory:", clock);
  const queue = new Queue(state, clock);
  return { clock, state, queue };
}

const DEPLOY = { kind: "deploy", resourceKind: "service", resourceId: "hello" } as const;

describe("Queue enqueue + claim", () => {
  it("enqueue then claim runs FIFO", () => {
    const { queue } = setup();
    const a = queue.enqueue({ ...DEPLOY, payload: { tag: "v1" } });
    const b = queue.enqueue({ ...DEPLOY, resourceId: "world", payload: { tag: "v2" } });
    expect(queue.claim("w1")?.id).toBe(a);
    expect(queue.claim("w1")?.id).toBe(b);
    expect(queue.claim("w1")).toBeNull();
  });

  it("enqueue with an explicit id (= deployment id) is honored", () => {
    const { queue } = setup();
    expect(queue.enqueue({ ...DEPLOY, id: 42, payload: { tag: "v1" } })).toBe(42);
    expect(queue.claim("w1")?.id).toBe(42);
  });

  it("outstandingCount counts only pending+running (not done/failed)", () => {
    const { queue } = setup();
    expect(queue.outstandingCount()).toBe(0);
    const a = queue.enqueue({ ...DEPLOY, payload: { tag: "v1" } });
    queue.enqueue({ ...DEPLOY, resourceId: "world", payload: { tag: "v2" } });
    expect(queue.outstandingCount()).toBe(2); // two pending
    queue.claim("w1"); // a → running
    expect(queue.outstandingCount()).toBe(2); // one running + one pending
    queue.complete(a); // a → done
    expect(queue.outstandingCount()).toBe(1);
  });

  it("claim marks the job running, bumps attempts, and sets a lease", () => {
    const { queue, clock } = setup(1000);
    queue.enqueue({ ...DEPLOY });
    const job = queue.claim("w1", 30_000)!;
    expect(job.state).toBe("running");
    expect(job.attempts).toBe(1);
    expect(job.lease_holder).toBe("w1");
    expect(job.lease_until).toBe(new Date(31_000).toISOString());
  });

  it("claim is atomic against concurrent workers — exactly one ends up running", async () => {
    const { queue, state } = setup();
    queue.enqueue({ ...DEPLOY });
    const results = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => queue.claim("w"))));
    expect(results.filter(Boolean).length).toBe(1);
    const running = state.database.query("SELECT COUNT(*) n FROM jobs WHERE state='running'").get() as { n: number };
    expect(running.n).toBe(1);
  });

  it("hasActiveJob reports pending/running jobs and ignores terminal ones", () => {
    const { queue } = setup();
    expect(queue.hasActiveJob("hello", "deploy")).toBe(false);
    const id = queue.enqueue({ ...DEPLOY });
    expect(queue.hasActiveJob("hello", "deploy")).toBe(true); // pending
    const job = queue.claim("w1")!;
    expect(queue.hasActiveJob("hello", "deploy")).toBe(true); // running
    queue.complete(job.id, "w1");
    expect(queue.hasActiveJob("hello", "deploy")).toBe(false); // done
    expect(queue.hasActiveJob("hello", "other-kind")).toBe(false);
    expect(id).toBeGreaterThan(0);
  });

  it("does not claim a job whose next_attempt_at is in the future", () => {
    const { queue } = setup(0);
    const id = queue.enqueue({ ...DEPLOY });
    queue.claim("w1"); // running, attempts=1
    queue.fail(id, "boom"); // reschedules with backoff into the future
    expect(queue.claim("w1")).toBeNull();
  });
});

describe("Queue lease + retry + backoff", () => {
  it("expired lease is reaped and re-claimable, with a higher fencing token", () => {
    const { queue, clock } = setup(0);
    const id = queue.enqueue({ ...DEPLOY });
    const first = queue.claim("w1", 30_000)!;
    const lock1 = queue.acquireLock(first.resource_id, "w1", 30_000)!;
    queue.setFencingToken(id, lock1.token);

    clock.advance(31_000); // lease (and lock) expire
    expect(queue.reapExpiredLeases()).toBe(1);

    const second = queue.claim("w2", 30_000)!;
    expect(second.id).toBe(id);
    const lock2 = queue.acquireLock(second.resource_id, "w2", 30_000)!;
    expect(lock2.token).toBeGreaterThan(lock1.token);
  });

  it("repeated handler failures past max_attempts move the job to failed", () => {
    const { queue, clock } = setup(0);
    const id = queue.enqueue({ ...DEPLOY, maxAttempts: 2 });
    expect(queue.claim("w1")).not.toBeNull(); // attempts=1
    expect(queue.fail(id, "e1")).toBe("pending");
    clock.advance(backoffMs(1) + 1); // past the backoff so it's claimable again
    expect(queue.claim("w1")).not.toBeNull(); // attempts=2
    expect(queue.fail(id, "e2")).toBe("failed");
    expect(queue.getJob(id)!.state).toBe("failed");
    expect(queue.getJob(id)!.last_error).toBe("e2");
  });

  it("lease expiry that exhausts attempts moves the job to dead (distinct from failed)", () => {
    const { queue, clock } = setup(0);
    const id = queue.enqueue({ ...DEPLOY, maxAttempts: 1 });
    queue.claim("w1", 30_000); // attempts=1, == max
    clock.advance(31_000); // lease expires; worker presumed dead
    expect(queue.reapExpiredLeases()).toBe(1);
    expect(queue.getJob(id)!.state).toBe("dead");
    expect(queue.getJob(id)!.last_error).toBe("lease expired");
  });

  it("backoff is monotonic (delay grows with attempts, capped at 60s)", () => {
    const { queue, clock } = setup(0);
    const id = queue.enqueue({ ...DEPLOY, maxAttempts: 10 });
    let prevDelay = -1;
    let lastDelay = 0;
    for (let i = 0; i < 5; i++) {
      expect(queue.claim("w1")).not.toBeNull(); // claimable: clock advanced past the prior backoff
      const before = clock.now();
      queue.fail(id, "e");
      lastDelay = Date.parse(queue.getJob(id)!.next_attempt_at) - before;
      expect(lastDelay).toBeGreaterThanOrEqual(prevDelay);
      prevDelay = lastDelay;
      clock.advance(lastDelay + 1); // make the job claimable again
    }
    expect(lastDelay).toBeLessThanOrEqual(60_000);
  });

  it("heartbeat extends the lease", () => {
    const { queue, clock } = setup(0);
    const id = queue.enqueue({ ...DEPLOY });
    queue.claim("w1", 30_000); // lease_until = 30s
    clock.advance(9_000); // t=9s
    queue.heartbeat(id, 30_000); // lease_until = 39s
    expect(queue.getJob(id)!.lease_until).toBe(new Date(39_000).toISOString());
    clock.advance(9_000); // t=18s < 39s — still valid, not reaped
    expect(queue.reapExpiredLeases()).toBe(0);
    clock.advance(22_000); // t=40s > 39s — now expired
    expect(queue.reapExpiredLeases()).toBe(1);
  });
});

describe("fencing gate", () => {
  it("a stale fencing token cannot overwrite current_deployment", () => {
    const { state } = setup(0);
    expect(state.setCurrentFenced("hello", "v2", 5)).toBe(true);
    expect(state.setCurrentFenced("hello", "v1-stale", 3)).toBe(false); // lower token fenced out
    expect(state.getCurrent("hello")!.tag).toBe("v2");
    expect(state.setCurrentFenced("hello", "v3", 6)).toBe(true); // higher token wins
    expect(state.getCurrent("hello")!.tag).toBe("v3");
  });
});
