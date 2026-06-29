import { describe, it, expect } from "bun:test";
import {
  allocatePort,
  allocateExposePorts,
  NODEPORT_RANGE,
  SERVICE_PORT_RANGE,
  type PortConflict,
} from "./port-allocator.ts";

describe("allocatePort", () => {
  it("returns the desired port when it is free", () => {
    const r = allocatePort({ desired: 8080, used: new Set(), range: [1024, 65535] });
    expect(r).toEqual({ port: 8080, reassigned: false });
  });

  it("returns the next free port above the desired one when desired is taken", () => {
    const r = allocatePort({ desired: 8080, used: new Set([8080, 8081, 8082]), range: [1024, 65535] });
    expect(r).toEqual({ port: 8083, reassigned: true, originalPort: 8080 });
  });

  it("wraps from the top of the range to the bottom when the upper part is full", () => {
    const r = allocatePort({
      desired: 32766,
      used: new Set([32766, 32767]),
      range: NODEPORT_RANGE,
    });
    expect(r).toEqual({ port: 30000, reassigned: true, originalPort: 32766 });
  });

  it("returns null when every port in the range is taken", () => {
    const all = new Set<number>();
    for (let p = 30000; p <= 30005; p++) all.add(p);
    const r = allocatePort({ desired: 30000, used: all, range: [30000, 30005] });
    expect(r).toBeNull();
  });

  it("respects an explicit exclude list (e.g. reserved ports)", () => {
    const r = allocatePort({
      desired: 8080,
      used: new Set([8080]),
      range: [8080, 8090],
      exclude: new Set([8081, 8082, 8083]),
    });
    expect(r).toEqual({ port: 8084, reassigned: true, originalPort: 8080 });
  });

  it("clamps a desired port outside the range to the range start (and treats it as reassigned)", () => {
    const r = allocatePort({ desired: 80, used: new Set(), range: [30000, 32767] });
    expect(r).toEqual({ port: 30000, reassigned: true, originalPort: 80 });
  });
});

describe("allocateExposePorts", () => {
  const cluster = {
    nodePortsInUse: new Set<number>([30080, 30081]),
    servicePortsByNamespace: new Map<string, Set<number>>([
      ["default", new Set<number>([8080, 8081])],
      ["other", new Set<number>([3000])],
    ]),
  };

  it("returns the unchanged spec when nothing conflicts", () => {
    const r = allocateExposePorts(
      { type: "ClusterIP", port: 9090, protocol: "TCP" },
      "default",
      cluster,
    );
    expect(r.expose.port).toBe(9090);
    expect(r.conflicts).toEqual([]);
  });

  it("reassigns a ClusterIP port that conflicts within the namespace", () => {
    const r = allocateExposePorts(
      { type: "ClusterIP", port: 8080, protocol: "TCP" },
      "default",
      cluster,
    );
    expect(r.expose.port).toBe(8082);
    expect(r.conflicts).toEqual<PortConflict[]>([
      { kind: "service-port", namespace: "default", original: 8080, reassigned: 8082 },
    ]);
  });

  it("does not see a port conflict if the colliding service is in a DIFFERENT namespace", () => {
    const r = allocateExposePorts(
      { type: "ClusterIP", port: 3000, protocol: "TCP" },
      "default",
      cluster,
    );
    expect(r.expose.port).toBe(3000);
    expect(r.conflicts).toEqual([]);
  });

  it("reassigns a NodePort when the desired NodePort is taken on the cluster", () => {
    const r = allocateExposePorts(
      { type: "NodePort", port: 8080, nodePort: 30080, protocol: "TCP" },
      "default",
      cluster,
    );
    expect(r.expose.nodePort).toBe(30082); // first free above 30081
    const c = r.conflicts.find((x) => x.kind === "node-port")!;
    expect(c).toMatchObject({ kind: "node-port", original: 30080, reassigned: 30082 });
  });

  it("auto-allocates a NodePort when the operator omitted nodePort on a NodePort Service", () => {
    const r = allocateExposePorts(
      { type: "NodePort", port: 8080, protocol: "TCP" },
      "default",
      cluster,
    );
    expect(r.expose.nodePort).toBeGreaterThanOrEqual(NODEPORT_RANGE[0]);
    expect(r.expose.nodePort).toBeLessThanOrEqual(NODEPORT_RANGE[1]);
    expect(cluster.nodePortsInUse.has(r.expose.nodePort!)).toBe(false);
  });

  it("leaves NodePort/nodePort untouched when type is ClusterIP", () => {
    const r = allocateExposePorts(
      { type: "ClusterIP", port: 8080, nodePort: 30080, protocol: "TCP" },
      "default",
      cluster,
    );
    // nodePort is ignored for ClusterIP — still no conflict reported for it
    expect(r.conflicts.some((c) => c.kind === "node-port")).toBe(false);
  });

  it("reports BOTH a port and a nodePort conflict when both clash", () => {
    const r = allocateExposePorts(
      { type: "NodePort", port: 8080, nodePort: 30080, protocol: "TCP" },
      "default",
      cluster,
    );
    expect(r.conflicts.map((c) => c.kind).sort()).toEqual(["node-port", "service-port"]);
  });
});

describe("range constants", () => {
  it("NODEPORT_RANGE matches the Kubernetes default 30000-32767", () => {
    expect(NODEPORT_RANGE).toEqual([30000, 32767]);
  });

  it("SERVICE_PORT_RANGE covers a sane operator-facing band", () => {
    expect(SERVICE_PORT_RANGE[0]).toBeGreaterThanOrEqual(1024);
    expect(SERVICE_PORT_RANGE[1]).toBeLessThanOrEqual(65535);
  });
});
