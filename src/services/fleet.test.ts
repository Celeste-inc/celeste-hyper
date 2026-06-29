import { describe, it, expect } from "bun:test";
import { aggregateFleet, type FleetInputs } from "./fleet.ts";
import type { DeploymentRow } from "../lib/state.ts";

const baseInputs: FleetInputs = {
  clusters: [
    { id: "prod-eu", name: "Prod EU", defaultNamespace: "default", runtime: "auto", enabled: true } as never,
    { id: "prod-us", name: "Prod US", defaultNamespace: "default", runtime: "auto", enabled: true } as never,
  ],
  health: [
    { clusterId: "prod-eu", ok: true, reachable: true, message: "ok", checkedAt: "2026-06-29T10:00:00Z" },
    { clusterId: "prod-us", ok: false, reachable: false, message: "timeout", checkedAt: "2026-06-29T10:00:00Z" },
  ],
  services: [
    { name: "api", clusterId: "prod-eu", namespace: "default" } as never,
    { name: "worker", clusterId: "prod-eu", namespace: "default" } as never,
    { name: "etl", clusterId: "prod-us", namespace: "data" } as never,
  ],
  degraded: new Map([["etl", { reason: "health-gate-failed", at: "2026-06-29T09:00:00Z" }]]),
  recentDeployments: [
    { id: 1, service: "api", tag: "v9", status: "done", started_at: "2026-06-29T08:00:00Z", finished_at: "2026-06-29T08:02:00Z", action: "deploy", message: null, health_gate_result: null },
    { id: 2, service: "worker", tag: "v3", status: "failed", started_at: "2026-06-29T08:30:00Z", finished_at: "2026-06-29T08:32:00Z", action: "deploy", message: "image pull error", health_gate_result: null },
    { id: 3, service: "etl", tag: "v1", status: "applying", started_at: "2026-06-29T10:00:00Z", finished_at: null, action: "deploy", message: null, health_gate_result: null },
  ] as DeploymentRow[],
  capabilities: new Map([
    ["prod-eu", { hpaV2: true, metricsServerV1Beta1: true, helmCli: true, ingressV1: true }],
    ["prod-us", { hpaV2: true, metricsServerV1Beta1: false, helmCli: false, ingressV1: true }],
  ]),
  unmanagedByCluster: new Map([
    ["prod-eu", 2],
    ["prod-us", 5],
  ]),
};

describe("aggregateFleet", () => {
  it("returns one cluster entry per registered cluster with health + capability summary", async () => {
    const fleet = aggregateFleet(baseInputs);
    expect(fleet.clusters).toHaveLength(2);
    const eu = fleet.clusters.find((c) => c.id === "prod-eu")!;
    expect(eu.health.ok).toBe(true);
    expect(eu.capabilities).toEqual({ hpaV2: true, metricsServerV1Beta1: true, helmCli: true, ingressV1: true });
    expect(eu.services.total).toBe(2);
    expect(eu.unmanaged).toBe(2);
  });

  it("computes per-cluster service health (degraded vs healthy)", async () => {
    const fleet = aggregateFleet(baseInputs);
    const us = fleet.clusters.find((c) => c.id === "prod-us")!;
    expect(us.services).toMatchObject({ total: 1, degraded: 1, healthy: 0 });
    const eu = fleet.clusters.find((c) => c.id === "prod-eu")!;
    expect(eu.services).toMatchObject({ total: 2, degraded: 0, healthy: 2 });
  });

  it("emits a top-level summary across all clusters", async () => {
    const fleet = aggregateFleet(baseInputs);
    expect(fleet.summary).toMatchObject({
      clusters: 2,
      reachableClusters: 1,
      services: 3,
      degradedServices: 1,
      unmanagedWorkloads: 7,
      activeDeployments: 1, // etl is "applying"
      failedDeploys24h: 1,
    });
  });

  it("returns recent activity sorted newest-first across clusters (capped)", async () => {
    const fleet = aggregateFleet(baseInputs);
    const activity = fleet.recentActivity;
    expect(activity.length).toBeGreaterThan(0);
    const times = activity.map((a) => a.startedAt);
    expect(times).toEqual([...times].sort().reverse()); // descending
    // The "applying" etl deploy should be first
    expect(activity[0]!.service).toBe("etl");
    expect(activity[0]!.status).toBe("applying");
  });

  it("handles an empty fleet without throwing", async () => {
    const fleet = aggregateFleet({ clusters: [], health: [], services: [], degraded: new Map(), recentDeployments: [], capabilities: new Map(), unmanagedByCluster: new Map() });
    expect(fleet.clusters).toEqual([]);
    expect(fleet.summary).toMatchObject({ clusters: 0, services: 0, degradedServices: 0 });
  });

  it("tolerates a service that points at a cluster which is no longer registered (orphan)", async () => {
    const inputs: FleetInputs = {
      ...baseInputs,
      services: [...baseInputs.services, { name: "orphan", clusterId: "ghost-cluster", namespace: "default" } as never],
    };
    const fleet = aggregateFleet(inputs);
    expect(fleet.orphanServices).toEqual(["orphan"]);
    expect(fleet.summary.services).toBe(4); // counted, even though no cluster bucket exists
  });
});
