import { describe, it, expect } from "bun:test";
import { fakeClock, type FakeClock } from "../lib/clock.ts";
import { runHealthGate, type HealthGateSample, type HealthGateResult } from "./health-gate.ts";

const gate = { attempts: 6, intervalSec: 5, successThreshold: 3 };

function sampler(samples: HealthGateSample[]): () => Promise<HealthGateSample> {
  let i = 0;
  return async () => samples[Math.min(i++, samples.length - 1)]!;
}

const ready = (over: Partial<HealthGateSample> = {}): HealthGateSample => ({
  readyReplicas: 2,
  replicas: 2,
  observedGeneration: 5,
  generation: 5,
  pods: [{ phase: "Running", maxRestarts: 0 }],
  ...over,
});

/** Drive the gate's internal delays via the fake clock until it settles. */
async function run(clock: FakeClock, p: Promise<HealthGateResult>): Promise<HealthGateResult> {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 50 && !done; i++) {
    await Promise.resolve();
    clock.advance(5000);
    await Promise.resolve();
  }
  return p;
}

describe("runHealthGate", () => {
  it("passes when readyReplicas == replicas across the success threshold", async () => {
    const clock = fakeClock(0);
    const res = await run(clock, runHealthGate(sampler([ready(), ready(), ready()]), gate, clock));
    expect(res.ok).toBe(true);
    expect(res.lastReason).toBe("healthy");
  });

  it("fails fast on CrashLoopBackOff in the window", async () => {
    const clock = fakeClock(0);
    const crash = ready({ readyReplicas: 1, pods: [{ phase: "Running", maxRestarts: 3, waitingReason: "CrashLoopBackOff" }] });
    const res = await run(clock, runHealthGate(sampler([ready(), crash]), gate, clock));
    expect(res.ok).toBe(false);
    expect(res.lastReason).toBe("CrashLoopBackOff");
  });

  it("fails on a restartCount jump >= 2 within the window", async () => {
    const clock = fakeClock(0);
    const samples = [
      ready({ readyReplicas: 1, pods: [{ phase: "Running", maxRestarts: 0 }] }),
      ready({ readyReplicas: 1, pods: [{ phase: "Running", maxRestarts: 2 }] }),
    ];
    const res = await run(clock, runHealthGate(sampler(samples), gate, clock));
    expect(res.ok).toBe(false);
    expect(res.lastReason).toContain("restartCount jumped");
  });

  it("fails on observed-generation mismatch after timeout", async () => {
    const clock = fakeClock(0);
    // never ready, and observedGeneration stays behind → timeout → gen-mismatch reason
    const behind = ready({ readyReplicas: 1, observedGeneration: 4, generation: 5 });
    const res = await run(clock, runHealthGate(sampler([behind]), gate, clock));
    expect(res.ok).toBe(false);
    expect(res.lastReason).toContain("observedGeneration");
  });

  it("fails fast on OOMKilled", async () => {
    const clock = fakeClock(0);
    const oom = ready({ readyReplicas: 1, pods: [{ phase: "Running", maxRestarts: 1, terminatedReason: "OOMKilled" }] });
    const res = await run(clock, runHealthGate(sampler([oom]), gate, clock));
    expect(res.ok).toBe(false);
    expect(res.lastReason).toBe("OOMKilled");
  });
});
