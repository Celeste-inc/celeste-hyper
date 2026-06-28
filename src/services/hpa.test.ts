import { describe, it, expect } from "bun:test";
import { findHpaForWorkload, summarizeHpa, validateHpaPatch, buildHpaPatch, type Hpa, type HpaMetric } from "./hpa.ts";

const hpaWithCpuAndMemory: Hpa = {
  metadata: { name: "web", namespace: "default" },
  spec: {
    scaleTargetRef: { kind: "Deployment", name: "web" },
    minReplicas: 2,
    maxReplicas: 10,
    metrics: [
      { type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 70 } } },
      { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 50 } } },
    ],
  },
  status: { currentReplicas: 3, desiredReplicas: 4 },
};

describe("findHpaForWorkload", () => {
  it("matches by scaleTargetRef kind + name", () => {
    expect(findHpaForWorkload([hpaWithCpuAndMemory], "Deployment", "web")?.metadata?.name).toBe("web");
  });
  it("returns null when nothing targets the workload", () => {
    expect(findHpaForWorkload([hpaWithCpuAndMemory], "Deployment", "other")).toBeNull();
    expect(findHpaForWorkload([], "Deployment", "web")).toBeNull();
  });
});

describe("summarizeHpa", () => {
  it("normalizes the read view including the CPU target", () => {
    expect(summarizeHpa(hpaWithCpuAndMemory)).toEqual({
      name: "web",
      minReplicas: 2,
      maxReplicas: 10,
      currentReplicas: 3,
      desiredReplicas: 4,
      targetCPUUtilizationPercentage: 50,
      metricTypes: ["memory", "cpu"],
    });
  });
});

describe("buildHpaPatch", () => {
  it("preserves non-CPU metrics while updating the CPU target", () => {
    const patch = buildHpaPatch(hpaWithCpuAndMemory, { targetCPUUtilizationPercentage: 80 });
    const metrics = patch.spec.metrics as HpaMetric[];
    expect(metrics).toHaveLength(2);
    expect(metrics.find((m) => m.resource?.name === "memory")!.resource!.target!.averageUtilization).toBe(70);
    expect(metrics.find((m) => m.resource?.name === "cpu")!.resource!.target!.averageUtilization).toBe(80);
  });

  it("sets minReplicas/maxReplicas only when provided", () => {
    expect(buildHpaPatch(hpaWithCpuAndMemory, { min: 1, max: 5 }).spec).toEqual({ minReplicas: 1, maxReplicas: 5 });
    expect(buildHpaPatch(hpaWithCpuAndMemory, { min: 3 }).spec).toEqual({ minReplicas: 3 });
  });

  it("adds a CPU metric when the HPA has none", () => {
    const patch = buildHpaPatch({ spec: { metrics: [] } }, { targetCPUUtilizationPercentage: 60 });
    const metrics = patch.spec.metrics as HpaMetric[];
    expect(metrics[0]).toMatchObject({ type: "Resource", resource: { name: "cpu", target: { averageUtilization: 60 } } });
  });
});

describe("validateHpaPatch", () => {
  it("accepts in-range values", () => {
    expect(validateHpaPatch({ min: 2, max: 8, targetCPUUtilizationPercentage: 75 }, hpaWithCpuAndMemory)).toBeNull();
  });
  it("rejects min > max (cross-checked against current bounds)", () => {
    expect(validateHpaPatch({ min: 20 }, hpaWithCpuAndMemory)).toContain("out of range"); // 20 > current max 10
    expect(validateHpaPatch({ min: 9, max: 3 }, hpaWithCpuAndMemory)).toContain("out of range");
  });
  it("rejects out-of-range replicas and CPU", () => {
    expect(validateHpaPatch({ max: 2000 }, hpaWithCpuAndMemory)).toContain("out of range");
    expect(validateHpaPatch({ targetCPUUtilizationPercentage: 0 }, hpaWithCpuAndMemory)).toContain("targetCPU");
    expect(validateHpaPatch({ targetCPUUtilizationPercentage: 101 }, hpaWithCpuAndMemory)).toContain("targetCPU");
  });
});
