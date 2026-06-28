import { describe, it, expect } from "bun:test";
import { State } from "../lib/state.ts";
import { fakeClock, realClock, type Clock } from "../lib/clock.ts";
import { Queue } from "./queue.ts";
import { Worker, type WorkerOpts } from "./worker.ts";

const DEPLOY = { kind: "deploy", resourceKind: "service", resourceId: "hello" } as const;

function setup(clock: Clock = fakeClock(0)) {
  const state = new State(":memory:", clock);
  const queue = new Queue(state, clock);
  const mk = (handlers: WorkerOpts["handlers"], extra: Partial<WorkerOpts> = {}) =>
    new Worker({ queue, handlers, clock, holder: "w1", ...extra });
  return { state, queue, clock, mk };
}

describe("Worker.tick", () => {
  it("happy path marks the job done and records a fencing token", async () => {
    const { queue, mk } = setup();
    queue.enqueue({ ...DEPLOY });
    const worker = mk({ deploy: async () => {} });
    expect(await worker.tick()).toBe(true);
    const job = queue.getJob(1)!;
    expect(job.state).toBe("done");
    expect(job.last_error).toBeNull();
    expect(job.fencing_token).toBeGreaterThan(0);
  });

  it("invokes the audit sink on terminal outcomes (P2.1)", async () => {
    const { queue, mk } = setup();
    const events: Array<{ kind: string; result: string; message?: string }> = [];
    const audit = (job: { kind: string }, result: "ok" | "fail", message?: string) => events.push({ kind: job.kind, result, message });
    queue.enqueue({ ...DEPLOY });
    await mk({ deploy: async () => {} }, { audit }).tick();
    queue.enqueue({ ...DEPLOY, maxAttempts: 1 });
    await mk({ deploy: async () => { throw new Error("boom"); } }, { audit }).tick();
    expect(events).toEqual([
      { kind: "deploy", result: "ok", message: undefined },
      { kind: "deploy", result: "fail", message: "boom" },
    ]);
  });

  it("does not audit a retry, only the terminal failure (P2.1)", async () => {
    const { queue, mk } = setup();
    const results: string[] = [];
    const audit = (_job: { kind: string }, result: "ok" | "fail") => results.push(result);
    queue.enqueue({ ...DEPLOY, maxAttempts: 2 });
    await mk({ deploy: async () => { throw new Error("x"); } }, { audit }).tick(); // attempt 1 → requeued
    expect(results).toEqual([]); // no audit for a retry
  });

  it("handler error marks the job failed and bumps attempts", async () => {
    const { queue, mk } = setup();
    queue.enqueue({ ...DEPLOY, maxAttempts: 1 });
    const worker = mk({ deploy: async () => { throw new Error("kubectl: set-image boom"); } });
    expect(await worker.tick()).toBe(true);
    const job = queue.getJob(1)!;
    expect(job.state).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toContain("boom");
  });

  it("a handler error with attempts remaining requeues as pending (retry)", async () => {
    const { queue, mk } = setup();
    queue.enqueue({ ...DEPLOY, maxAttempts: 3 });
    const worker = mk({ deploy: async () => { throw new Error("transient"); } });
    await worker.tick();
    expect(queue.getJob(1)!.state).toBe("pending");
    expect(queue.getJob(1)!.attempts).toBe(1);
  });

  it("releases the per-resource lock after the job so the next deploy can claim it", async () => {
    const { queue, mk } = setup();
    queue.enqueue({ ...DEPLOY });
    await mk({ deploy: async () => {} }).tick();
    // lock should be free again: a fresh acquire succeeds
    expect(queue.acquireLock("hello", "someone-else", 1000)).not.toBeNull();
  });

  it("does not claim a new job once stopping (signal arrival)", async () => {
    const { queue, mk } = setup();
    queue.enqueue({ ...DEPLOY });
    const worker = mk({ deploy: async () => {} });
    await worker.stop(); // nothing in flight → returns immediately, sets stopping
    expect(await worker.tick()).toBe(false);
    expect(queue.getJob(1)!.state).toBe("pending");
  });
});

describe("Worker graceful shutdown", () => {
  it("stop() waits for the in-flight job to finish", async () => {
    const { queue, state } = setup(realClock()); // real clock: ordering via promises, not timers
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const worker = new Worker({
      queue,
      handlers: { deploy: () => gate },
      clock: realClock(),
      holder: "w1",
      shutdownGraceMs: 30_000,
    });
    queue.enqueue({ ...DEPLOY });

    const ticking = worker.tick(); // claims + runs handler, parks on gate
    await Promise.resolve();
    let stopped = false;
    let drained: boolean | undefined;
    const stopping = worker.stop().then((d) => { drained = d; stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false); // still waiting on the running job
    expect(queue.getJob(1)!.state).toBe("running");

    releaseGate();
    await ticking;
    await stopping;
    expect(stopped).toBe(true);
    expect(drained).toBe(true); // job finished within the grace period
    expect(queue.getJob(1)!.state).toBe("done");
    state.close();
  });

  it("stop() returns false when the running job outlives the grace period", async () => {
    const clock = fakeClock(0);
    const { queue } = setup(clock);
    queue.enqueue({ ...DEPLOY });
    const worker = new Worker({
      queue,
      handlers: { deploy: () => new Promise<void>(() => {}) }, // never resolves
      clock,
      holder: "w1",
      shutdownGraceMs: 30_000,
      heartbeatMs: 10_000,
    });
    void worker.tick(); // claims + runs the never-ending handler
    await Promise.resolve();
    const stopping = worker.stop();
    clock.advance(30_000); // fire the grace timer
    expect(await stopping).toBe(false);
  });
});
