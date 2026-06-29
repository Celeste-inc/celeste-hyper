import { describe, it, expect } from "bun:test";
import { computeServiceSlo, type SloInputs } from "./slo.ts";
import type { DeploymentRow } from "../lib/state.ts";

function dep(overrides: Partial<DeploymentRow>): DeploymentRow {
  return {
    id: 1,
    service: "api",
    tag: "v1",
    status: "done",
    started_at: "2026-06-29T00:00:00Z",
    finished_at: "2026-06-29T00:01:00Z",
    message: null,
    action: "deploy",
    health_gate_result: null,
    ...overrides,
  };
}

describe("computeServiceSlo", () => {
  const now = Date.parse("2026-06-29T12:00:00Z");

  it("computes deploy success rate as done / (done + failed)", () => {
    const inputs: SloInputs = {
      now,
      deployments: [
        dep({ id: 1, status: "done", started_at: "2026-06-28T00:00:00Z", finished_at: "2026-06-28T00:01:00Z" }),
        dep({ id: 2, status: "done", started_at: "2026-06-28T01:00:00Z", finished_at: "2026-06-28T01:01:00Z" }),
        dep({ id: 3, status: "failed", started_at: "2026-06-28T02:00:00Z", finished_at: "2026-06-28T02:01:00Z" }),
      ],
      restartCounts: [],
      degradedRanges: [],
    };
    const slo = computeServiceSlo(inputs);
    expect(slo.deploy.totalAttempts).toBe(3);
    expect(slo.deploy.successful).toBe(2);
    expect(slo.deploy.failed).toBe(1);
    expect(slo.deploy.successRate).toBeCloseTo(2 / 3, 3);
  });

  it("returns a null success rate when no terminal deploys exist (avoids divide-by-zero)", () => {
    const slo = computeServiceSlo({
      now,
      deployments: [dep({ status: "applying", finished_at: null })],
      restartCounts: [],
      degradedRanges: [],
    });
    expect(slo.deploy.totalAttempts).toBe(0); // an in-flight deploy is not yet an attempt
    expect(slo.deploy.successRate).toBeNull();
  });

  it("computes deploys-per-day frequency over the last 7d window", () => {
    const inputs: SloInputs = {
      now,
      deployments: [
        // 14 deploys spread evenly over the past 7 days = 2/day
        ...Array.from({ length: 14 }, (_, i) =>
          dep({
            id: 100 + i,
            status: "done",
            started_at: new Date(now - i * 12 * 3600 * 1000).toISOString(),
            finished_at: new Date(now - i * 12 * 3600 * 1000 + 60_000).toISOString(),
          }),
        ),
      ],
      restartCounts: [],
      degradedRanges: [],
    };
    const slo = computeServiceSlo(inputs);
    expect(slo.deploy.frequencyPerDay).toBeCloseTo(2, 1);
  });

  it("computes MTTR (mean time to recover) from closed degraded ranges", () => {
    const inputs: SloInputs = {
      now,
      deployments: [],
      restartCounts: [],
      degradedRanges: [
        { startedAt: "2026-06-01T00:00:00Z", clearedAt: "2026-06-01T01:00:00Z" }, // 1h
        { startedAt: "2026-06-02T00:00:00Z", clearedAt: "2026-06-02T03:00:00Z" }, // 3h
      ],
    };
    const slo = computeServiceSlo(inputs);
    // Mean = (3600 + 10800) / 2 = 7200s
    expect(slo.incidents.totalIncidents).toBe(2);
    expect(slo.incidents.mttrSeconds).toBeCloseTo(7200, 0);
  });

  it("ignores currently-open incidents in MTTR but counts them as 'ongoing'", () => {
    const slo = computeServiceSlo({
      now,
      deployments: [],
      restartCounts: [],
      degradedRanges: [
        { startedAt: "2026-06-01T00:00:00Z", clearedAt: "2026-06-01T01:00:00Z" },
        { startedAt: "2026-06-29T11:00:00Z", clearedAt: null }, // ongoing
      ],
    });
    expect(slo.incidents.totalIncidents).toBe(2);
    expect(slo.incidents.ongoing).toBe(1);
    expect(slo.incidents.mttrSeconds).toBeCloseTo(3600, 0); // only the closed range
  });

  it("averages container restart counts across pods", () => {
    const slo = computeServiceSlo({
      now,
      deployments: [],
      restartCounts: [0, 0, 2, 4],
      degradedRanges: [],
    });
    expect(slo.runtime.totalRestarts).toBe(6);
    expect(slo.runtime.podCount).toBe(4);
    expect(slo.runtime.averageRestartsPerPod).toBe(1.5);
  });

  it("classifies the service health: HEALTHY when no incidents and 100% deploy success", () => {
    const inputs: SloInputs = {
      now,
      deployments: [dep({ status: "done" }), dep({ id: 2, status: "done" })],
      restartCounts: [0, 0],
      degradedRanges: [],
    };
    expect(computeServiceSlo(inputs).health).toBe("healthy");
  });

  it("classifies the service health: DEGRADED when an incident is ongoing", () => {
    const inputs: SloInputs = {
      now,
      deployments: [],
      restartCounts: [],
      degradedRanges: [{ startedAt: "2026-06-29T11:00:00Z", clearedAt: null }],
    };
    expect(computeServiceSlo(inputs).health).toBe("degraded");
  });

  it("classifies the service health: AT_RISK when success rate < 80% or pods crash-looping", () => {
    const inputs: SloInputs = {
      now,
      deployments: [
        dep({ id: 1, status: "done" }),
        dep({ id: 2, status: "failed" }),
        dep({ id: 3, status: "failed" }),
      ],
      restartCounts: [10, 20],
      degradedRanges: [],
    };
    expect(computeServiceSlo(inputs).health).toBe("at_risk");
  });
});
