import type { ClusterModel, ServiceModel } from "./model.ts";
import type { ClusterHealth } from "./k8s-pool.ts";
import type { DeploymentRow } from "../lib/state.ts";

const RECENT_ACTIVITY_LIMIT = 25;
const ACTIVE_STATUSES = new Set(["pending", "downloading", "loading", "applying"]);
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface DegradedMark {
  reason: string;
  at: string;
}

export type CapabilitySummary = Record<string, boolean>;

export interface FleetInputs {
  clusters: ClusterModel[];
  health: ClusterHealth[];
  services: ServiceModel[];
  degraded: Map<string, DegradedMark>;
  recentDeployments: DeploymentRow[];
  capabilities: Map<string, CapabilitySummary>;
  unmanagedByCluster: Map<string, number>;
  /** Caller-supplied current time (ms epoch) — keeps the 24h failure window deterministic for tests. */
  now: number;
}

export interface FleetClusterRow {
  id: string;
  name: string;
  defaultNamespace: string;
  runtime: string;
  health: ClusterHealth;
  capabilities: CapabilitySummary;
  services: {
    total: number;
    healthy: number;
    degraded: number;
  };
  unmanaged: number;
}

export interface FleetActivity {
  id: number;
  service: string;
  tag: string;
  status: string;
  action: string;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

export interface FleetSummary {
  clusters: number;
  reachableClusters: number;
  services: number;
  degradedServices: number;
  unmanagedWorkloads: number;
  activeDeployments: number;
  failedDeploys24h: number;
}

export interface FleetSnapshot {
  summary: FleetSummary;
  clusters: FleetClusterRow[];
  recentActivity: FleetActivity[];
  orphanServices: string[];
}

function unknownHealth(clusterId: string): ClusterHealth {
  return { clusterId, ok: false, reachable: false, message: "unknown", checkedAt: "" };
}

export function aggregateFleet(input: FleetInputs): FleetSnapshot {
  const healthById = new Map(input.health.map((h) => [h.clusterId, h]));
  const servicesByCluster = new Map<string, ServiceModel[]>();
  const orphanServices: string[] = [];
  const registeredClusterIds = new Set(input.clusters.map((c) => c.id));

  for (const svc of input.services) {
    if (!registeredClusterIds.has(svc.clusterId)) {
      orphanServices.push(svc.name);
      continue;
    }
    const bucket = servicesByCluster.get(svc.clusterId) ?? [];
    bucket.push(svc);
    servicesByCluster.set(svc.clusterId, bucket);
  }

  const clusters: FleetClusterRow[] = input.clusters.map((c) => {
    const svcList = servicesByCluster.get(c.id) ?? [];
    const degradedCount = svcList.filter((s) => input.degraded.has(s.name)).length;
    return {
      id: c.id,
      name: c.name,
      defaultNamespace: c.defaultNamespace,
      runtime: c.runtime,
      health: healthById.get(c.id) ?? unknownHealth(c.id),
      capabilities: input.capabilities.get(c.id) ?? {},
      services: {
        total: svcList.length,
        degraded: degradedCount,
        healthy: svcList.length - degradedCount,
      },
      unmanaged: input.unmanagedByCluster.get(c.id) ?? 0,
    };
  });

  const recentActivity: FleetActivity[] = [...input.recentDeployments]
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
    .slice(0, RECENT_ACTIVITY_LIMIT)
    .map((d) => ({
      id: d.id,
      service: d.service,
      tag: d.tag,
      status: d.status,
      action: d.action,
      startedAt: d.started_at,
      finishedAt: d.finished_at,
      message: d.message,
    }));

  const failedDeploys24h = input.recentDeployments.filter((d) => {
    if (d.status !== "failed") return false;
    const t = Date.parse(d.finished_at ?? d.started_at);
    return Number.isFinite(t) && input.now - t <= TWENTY_FOUR_HOURS_MS;
  }).length;

  const summary: FleetSummary = {
    clusters: input.clusters.length,
    reachableClusters: input.clusters.filter((c) => healthById.get(c.id)?.reachable === true).length,
    services: input.services.length,
    degradedServices: input.services.filter((s) => input.degraded.has(s.name)).length,
    unmanagedWorkloads: [...input.unmanagedByCluster.values()].reduce((a, b) => a + b, 0),
    activeDeployments: input.recentDeployments.filter((d) => ACTIVE_STATUSES.has(d.status)).length,
    failedDeploys24h,
  };

  return { summary, clusters, recentActivity, orphanServices };
}
