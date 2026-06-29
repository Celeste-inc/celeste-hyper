import type { ServiceClusterSummary } from "../types/api";

const IN_FLIGHT = new Set(["pending", "downloading", "loading", "applying"]);

export interface ServiceStatusInput {
  cluster: ServiceClusterSummary | null;
  activeDeployment: { status: string; started_at?: string; finished_at?: string | null } | null;
}

export type ServiceStatusTone = "ok" | "warn" | "bad";

export interface ServiceStatusResult {
  tone: ServiceStatusTone;
  label: string;
}

/**
 * Decide the visible status of a service. Strict rule: never paint "0/n ready" red while a
 * deployment is in flight — the operator just clicked Deploy, so the pill must read as
 * "deploying" (yellow). Red is reserved for an actual error state (terminal failed deploy or
 * a workload stuck at zero with no deploy explaining it).
 */
export function computeServiceStatus(input: ServiceStatusInput): ServiceStatusResult {
  const { cluster, activeDeployment } = input;

  // Deploy currently in flight → always yellow with a "deploying" label, regardless of replicas.
  if (activeDeployment && IN_FLIGHT.has(activeDeployment.status)) {
    return { tone: "warn", label: `Deploying… (${activeDeployment.status})` };
  }

  if (!cluster) return { tone: "warn", label: "Awaiting workload" };

  const { replicas, readyReplicas } = cluster;

  // Failed deploy in terminal state → real red.
  if (activeDeployment && activeDeployment.status === "failed") {
    return { tone: "bad", label: `Deploy failed (${readyReplicas}/${replicas} ready)` };
  }

  // Fresh workload, no replicas yet → yellow (pending), never red.
  if (replicas === 0) return { tone: "warn", label: "Pending — 0 replicas" };

  if (readyReplicas === replicas) return { tone: "ok", label: `${readyReplicas}/${replicas} ready` };

  // Some replicas ready but not all → still progressing, yellow.
  if (readyReplicas > 0) return { tone: "warn", label: `${readyReplicas}/${replicas} ready` };

  // 0 of N ready and no deploy explains it → red.
  return { tone: "bad", label: `${readyReplicas}/${replicas} ready` };
}
