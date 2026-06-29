import { describe, it, expect } from "bun:test";
import { State } from "../lib/state.ts";
import { fakeClock } from "../lib/clock.ts";
import { deployEvents, type DeployEventFrame } from "./deploy-stream.ts";

const TICK_MS = 50;

function setup() {
  const clock = fakeClock(0);
  const state = new State(":memory:", clock);
  return { state, clock };
}

async function collect(
  iter: AsyncIterable<DeployEventFrame>,
  controller: AbortController,
  clock: ReturnType<typeof fakeClock>,
  events: DeployEventFrame[],
  driver: () => Promise<void>,
) {
  const reader = (async () => {
    for await (const ev of iter) {
      events.push(ev);
      if (ev.event === "end") break;
    }
  })();
  // The generator parks on `setTimeout(TICK_MS)` between polls. Each `clock.advance(TICK_MS)` wakes
  // exactly one poll; we drive the simulation by interleaving state mutations with advances.
  await driver();
  controller.abort();
  await reader;
}

async function pump(clock: ReturnType<typeof fakeClock>, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    clock.advance(TICK_MS);
    await Promise.resolve(); // yield so the generator can run
    await Promise.resolve();
  }
}

describe("deployEvents", () => {
  it("emits a status frame for every transition, ending on a terminal status", async () => {
    const { state, clock } = setup();
    const id = state.recordDeploymentStart("api", "v1");
    const ac = new AbortController();
    const events: DeployEventFrame[] = [];
    await collect(deployEvents(state, id, clock, ac.signal, TICK_MS), ac, clock, events, async () => {
      await pump(clock, 1); // initial frame
      state.updateDeployment(id, "downloading", "pulling image");
      await pump(clock, 1);
      state.updateDeployment(id, "applying", "kubectl set image");
      await pump(clock, 1);
      state.updateDeployment(id, "done", "rolled out");
      await pump(clock, 2);
    });
    const statuses = events.filter((e) => e.event === "status").map((e) => JSON.parse(e.data) as { status: string });
    expect(statuses.map((s) => s.status)).toEqual(["pending", "downloading", "applying", "done"]);
    const last = events[events.length - 1]!;
    expect(last.event).toBe("end");
  });

  it("does not duplicate frames when nothing changed between polls", async () => {
    const { state, clock } = setup();
    const id = state.recordDeploymentStart("api", "v1");
    const ac = new AbortController();
    const events: DeployEventFrame[] = [];
    await collect(deployEvents(state, id, clock, ac.signal, TICK_MS), ac, clock, events, async () => {
      await pump(clock, 5); // many polls, no state change
      state.updateDeployment(id, "done", "ok");
      await pump(clock, 2);
    });
    const statusFrames = events.filter((e) => e.event === "status");
    // pending (initial) + done = 2; any duplicates would mean drift.
    expect(statusFrames).toHaveLength(2);
  });

  it("ends with an error frame when the deployment id is unknown", async () => {
    const { state, clock } = setup();
    const ac = new AbortController();
    const events: DeployEventFrame[] = [];
    await collect(deployEvents(state, 9999, clock, ac.signal, TICK_MS), ac, clock, events, async () => {
      await pump(clock, 1);
    });
    expect(events.some((e) => e.event === "error")).toBe(true);
    expect(events[events.length - 1]!.event).toBe("end");
  });

  it("respects abort: stops promptly when the client disconnects", async () => {
    const { state, clock } = setup();
    const id = state.recordDeploymentStart("api", "v1");
    const ac = new AbortController();
    const events: DeployEventFrame[] = [];
    const reader = (async () => {
      for await (const ev of deployEvents(state, id, clock, ac.signal, TICK_MS)) events.push(ev);
    })();
    await pump(clock, 1); // initial pending frame
    ac.abort();
    await pump(clock, 1);
    await reader;
    // No `end` frame: aborted disconnect, not a terminal status. Just the initial pending.
    expect(events.some((e) => e.event === "end")).toBe(false);
  });
});
