// HorizontalPodAutoscaler (autoscaling/v2) shapes — only the fields we read or write.
export interface HpaMetricTarget {
  type?: string;
  averageUtilization?: number;
  averageValue?: string;
  value?: string;
}
export interface HpaMetric {
  type: string;
  resource?: { name: string; target?: HpaMetricTarget };
  [k: string]: unknown;
}
export interface Hpa {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    scaleTargetRef?: { kind?: string; name?: string };
    minReplicas?: number;
    maxReplicas?: number;
    metrics?: HpaMetric[];
  };
  status?: { currentReplicas?: number; desiredReplicas?: number };
}

export interface HpaView {
  name: string;
  minReplicas: number | null;
  maxReplicas: number | null;
  currentReplicas: number | null;
  desiredReplicas: number | null;
  targetCPUUtilizationPercentage: number | null;
  metricTypes: string[];
}

export interface HpaPatchInput {
  min?: number;
  max?: number;
  targetCPUUtilizationPercentage?: number;
}

export const MIN_REPLICAS = 1;
export const MAX_REPLICAS = 1000;
export const MIN_CPU = 1;
export const MAX_CPU = 100;

function cpuMetric(metrics: HpaMetric[] | undefined): HpaMetric | undefined {
  return metrics?.find((m) => m.type === "Resource" && m.resource?.name === "cpu");
}

/** Find the HPA whose scaleTargetRef matches a workload (kind + name). */
export function findHpaForWorkload(hpas: Hpa[], kind: string, name: string): Hpa | null {
  return (
    hpas.find((h) => h.spec?.scaleTargetRef?.kind === kind && h.spec?.scaleTargetRef?.name === name) ?? null
  );
}

/** Normalized read view for the API/UI. */
export function summarizeHpa(hpa: Hpa): HpaView {
  return {
    name: hpa.metadata?.name ?? "",
    minReplicas: hpa.spec?.minReplicas ?? null,
    maxReplicas: hpa.spec?.maxReplicas ?? null,
    currentReplicas: hpa.status?.currentReplicas ?? null,
    desiredReplicas: hpa.status?.desiredReplicas ?? null,
    targetCPUUtilizationPercentage: cpuMetric(hpa.spec?.metrics)?.resource?.target?.averageUtilization ?? null,
    metricTypes: (hpa.spec?.metrics ?? []).map((m) => (m.type === "Resource" ? m.resource?.name ?? "resource" : m.type)),
  };
}

/** Validate the patch against the current HPA. Returns an error code, or null when valid. */
export function validateHpaPatch(input: HpaPatchInput, current: Hpa): string | null {
  const min = input.min ?? current.spec?.minReplicas ?? MIN_REPLICAS;
  const max = input.max ?? current.spec?.maxReplicas ?? MAX_REPLICAS; // permissive when max unknown
  if (min < MIN_REPLICAS || max > MAX_REPLICAS || min > max) return "min/max out of range (1 <= min <= max <= 1000)";
  if (input.targetCPUUtilizationPercentage !== undefined) {
    const cpu = input.targetCPUUtilizationPercentage;
    if (cpu < MIN_CPU || cpu > MAX_CPU) return "targetCPUUtilizationPercentage out of range (1..100)";
  }
  return null;
}

/**
 * Build an RFC-7386 JSON merge patch limited to minReplicas, maxReplicas, and the CPU metric.
 * Because merge patch REPLACES arrays wholesale, the CPU change re-emits the FULL metrics array
 * with only the CPU target mutated — so memory/custom metrics are preserved verbatim.
 */
export function buildHpaPatch(current: Hpa, input: HpaPatchInput): { spec: Record<string, unknown> } {
  const spec: Record<string, unknown> = {};
  if (input.min !== undefined) spec.minReplicas = input.min;
  if (input.max !== undefined) spec.maxReplicas = input.max;
  if (input.targetCPUUtilizationPercentage !== undefined) {
    const metrics: HpaMetric[] = JSON.parse(JSON.stringify(current.spec?.metrics ?? []));
    const cpu = cpuMetric(metrics);
    if (cpu && cpu.resource) {
      // Replace the target outright (don't spread): a prior AverageValue target would otherwise
      // leave a stale `averageValue` next to the new `averageUtilization` — an invalid HPA metric.
      cpu.resource.target = { type: "Utilization", averageUtilization: input.targetCPUUtilizationPercentage };
    } else {
      metrics.push({
        type: "Resource",
        resource: { name: "cpu", target: { type: "Utilization", averageUtilization: input.targetCPUUtilizationPercentage } },
      });
    }
    spec.metrics = metrics;
  }
  return { spec };
}
