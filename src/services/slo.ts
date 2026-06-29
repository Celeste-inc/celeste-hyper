import type { DeploymentRow } from "../lib/state.ts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SUCCESS_RATE_FLOOR = 0.8;
const CRASH_LOOP_RESTART_THRESHOLD = 5;

export type ServiceHealth = "healthy" | "at_risk" | "degraded";

export interface DegradedRange {
  startedAt: string;
  clearedAt: string | null;
}

export interface SloInputs {
  now: number;
  deployments: DeploymentRow[];
  /** Per-pod container restart counts (used to estimate runtime stability). */
  restartCounts: number[];
  degradedRanges: DegradedRange[];
}

export interface DeploySloMetrics {
  totalAttempts: number;
  successful: number;
  failed: number;
  successRate: number | null;
  frequencyPerDay: number;
}

export interface IncidentSloMetrics {
  totalIncidents: number;
  ongoing: number;
  mttrSeconds: number | null;
}

export interface RuntimeSloMetrics {
  podCount: number;
  totalRestarts: number;
  averageRestartsPerPod: number;
}

export interface ServiceSlo {
  health: ServiceHealth;
  deploy: DeploySloMetrics;
  incidents: IncidentSloMetrics;
  runtime: RuntimeSloMetrics;
}

function isTerminal(status: DeploymentRow["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function avg(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function classify(deploy: DeploySloMetrics, incidents: IncidentSloMetrics, runtime: RuntimeSloMetrics): ServiceHealth {
  if (incidents.ongoing > 0) return "degraded";
  if (deploy.successRate !== null && deploy.successRate < SUCCESS_RATE_FLOOR) return "at_risk";
  if (runtime.averageRestartsPerPod >= CRASH_LOOP_RESTART_THRESHOLD) return "at_risk";
  return "healthy";
}

export function computeServiceSlo(input: SloInputs): ServiceSlo {
  const successful = input.deployments.filter((d) => d.status === "done").length;
  const failed = input.deployments.filter((d) => d.status === "failed").length;
  const totalAttempts = input.deployments.filter((d) => isTerminal(d.status) && d.status !== "cancelled").length;
  const successRate = totalAttempts === 0 ? null : successful / totalAttempts;

  const recent = input.deployments.filter((d) => {
    const t = Date.parse(d.started_at);
    return Number.isFinite(t) && input.now - t <= SEVEN_DAYS_MS;
  });
  const frequencyPerDay = recent.length / 7;

  const closedDurations = input.degradedRanges
    .filter((r) => r.clearedAt !== null)
    .map((r) => (Date.parse(r.clearedAt!) - Date.parse(r.startedAt)) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0);
  const ongoing = input.degradedRanges.filter((r) => r.clearedAt === null).length;
  const incidents: IncidentSloMetrics = {
    totalIncidents: input.degradedRanges.length,
    ongoing,
    mttrSeconds: closedDurations.length === 0 ? null : avg(closedDurations),
  };

  const podCount = input.restartCounts.length;
  const totalRestarts = input.restartCounts.reduce((s, r) => s + r, 0);
  const runtime: RuntimeSloMetrics = {
    podCount,
    totalRestarts,
    averageRestartsPerPod: podCount === 0 ? 0 : totalRestarts / podCount,
  };

  const deploy: DeploySloMetrics = { totalAttempts, successful, failed, successRate, frequencyPerDay };
  return { health: classify(deploy, incidents, runtime), deploy, incidents, runtime };
}
