import { describe, it, expect } from "bun:test";
import {
  parseTopPods,
  parseTopNodes,
  summarizePodMetrics,
  parseCpuToMillicores,
  parseMemoryToMebibytes,
  type PodMetric,
} from "./metrics.ts";

describe("parseCpuToMillicores", () => {
  it("parses millicores (suffix m)", () => {
    expect(parseCpuToMillicores("250m")).toBe(250);
    expect(parseCpuToMillicores("1m")).toBe(1);
    expect(parseCpuToMillicores("0m")).toBe(0);
  });

  it("parses whole cores (no suffix) as millicores", () => {
    expect(parseCpuToMillicores("1")).toBe(1000);
    expect(parseCpuToMillicores("2")).toBe(2000);
  });

  it("parses fractional cores", () => {
    expect(parseCpuToMillicores("0.5")).toBe(500);
    expect(parseCpuToMillicores("0.125")).toBe(125);
  });

  it("parses nanocores (suffix n)", () => {
    expect(parseCpuToMillicores("500000000n")).toBe(500);
    expect(parseCpuToMillicores("1500000n")).toBeCloseTo(1.5, 1);
  });

  it("returns 0 for unparseable values", () => {
    expect(parseCpuToMillicores("")).toBe(0);
    expect(parseCpuToMillicores("garbage")).toBe(0);
    expect(parseCpuToMillicores("<none>")).toBe(0);
  });
});

describe("parseMemoryToMebibytes", () => {
  it("parses Mi", () => {
    expect(parseMemoryToMebibytes("128Mi")).toBe(128);
    expect(parseMemoryToMebibytes("1Mi")).toBe(1);
  });

  it("parses Gi as 1024 Mi", () => {
    expect(parseMemoryToMebibytes("1Gi")).toBe(1024);
    expect(parseMemoryToMebibytes("2Gi")).toBe(2048);
  });

  it("parses Ki", () => {
    expect(parseMemoryToMebibytes("1024Ki")).toBe(1);
    expect(parseMemoryToMebibytes("2048Ki")).toBe(2);
  });

  it("parses raw bytes (no suffix)", () => {
    expect(parseMemoryToMebibytes(String(128 * 1024 * 1024))).toBe(128);
  });

  it("returns 0 for unparseable values", () => {
    expect(parseMemoryToMebibytes("")).toBe(0);
    expect(parseMemoryToMebibytes("nope")).toBe(0);
  });
});

describe("parseTopPods", () => {
  it("parses the standard `kubectl top pods --no-headers` output", () => {
    const stdout = [
      "hello-7d8b5c4f5-abc12   25m    64Mi",
      "hello-7d8b5c4f5-def34   100m   128Mi",
    ].join("\n");
    const items = parseTopPods(stdout);
    expect(items).toEqual([
      { pod: "hello-7d8b5c4f5-abc12", cpuMillicores: 25, memoryMi: 64 },
      { pod: "hello-7d8b5c4f5-def34", cpuMillicores: 100, memoryMi: 128 },
    ]);
  });

  it("parses container-level output (--containers) keeping container name", () => {
    const stdout = [
      "hello-abc12   app       25m    64Mi",
      "hello-abc12   sidecar   5m     16Mi",
    ].join("\n");
    const items = parseTopPods(stdout);
    expect(items).toEqual([
      { pod: "hello-abc12", container: "app", cpuMillicores: 25, memoryMi: 64 },
      { pod: "hello-abc12", container: "sidecar", cpuMillicores: 5, memoryMi: 16 },
    ]);
  });

  it("tolerates blank lines and trims rows", () => {
    const stdout = "\n  hello-abc   10m   32Mi  \n\n";
    expect(parseTopPods(stdout)).toEqual([
      { pod: "hello-abc", cpuMillicores: 10, memoryMi: 32 },
    ]);
  });

  it("skips malformed rows rather than throwing", () => {
    const stdout = ["not-enough-cols", "good-pod   10m   32Mi"].join("\n");
    expect(parseTopPods(stdout)).toEqual([
      { pod: "good-pod", cpuMillicores: 10, memoryMi: 32 },
    ]);
  });

  it("returns empty array for empty stdout", () => {
    expect(parseTopPods("")).toEqual([]);
  });
});

describe("parseTopNodes", () => {
  it("parses node-level CPU/memory with percentage columns", () => {
    const stdout = [
      "node-a   250m   12%   512Mi   25%",
      "node-b   1000m  50%   2Gi     50%",
    ].join("\n");
    const nodes = parseTopNodes(stdout);
    expect(nodes).toEqual([
      { node: "node-a", cpuMillicores: 250, cpuPercent: 12, memoryMi: 512, memoryPercent: 25 },
      { node: "node-b", cpuMillicores: 1000, cpuPercent: 50, memoryMi: 2048, memoryPercent: 50 },
    ]);
  });
});

describe("summarizePodMetrics", () => {
  it("sums CPU and memory across pods", () => {
    const items: PodMetric[] = [
      { pod: "a", cpuMillicores: 100, memoryMi: 64 },
      { pod: "b", cpuMillicores: 50, memoryMi: 32 },
    ];
    expect(summarizePodMetrics(items)).toEqual({
      podCount: 2,
      totalCpuMillicores: 150,
      totalMemoryMi: 96,
      avgCpuMillicores: 75,
      avgMemoryMi: 48,
    });
  });

  it("returns zeros for empty input without dividing by zero", () => {
    expect(summarizePodMetrics([])).toEqual({
      podCount: 0,
      totalCpuMillicores: 0,
      totalMemoryMi: 0,
      avgCpuMillicores: 0,
      avgMemoryMi: 0,
    });
  });
});
