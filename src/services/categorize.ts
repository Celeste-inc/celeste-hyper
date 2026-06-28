export type WorkloadCategory = "application" | "infrastructure";

export const DEFAULT_INFRA_NAMESPACES = ["kube-system", "kube-public", "kube-node-lease"];
export const DEFAULT_INFRA_NAMESPACE_REGEX = "^kube-|^cattle-";

export interface CategorizeConfig {
  infraNamespaces?: string[];
  infraNamespaceRegex?: string;
  /** Precompiled infra-namespace regex (preferred — compiled once per scan, not per workload). */
  infraRegex?: RegExp | null;
}

export interface CategorizableWorkload {
  namespace: string;
  kind: string;
  name: string;
  labels?: Record<string, string>;
}

/** Compile an infra-namespace regex, returning null on a bad pattern (caller decides how to react). */
export function compileInfraRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

/**
 * Classify a discovered workload as `application` or `infrastructure`. An explicit operator
 * override always wins; otherwise the default rules (self-label, Helm-in-kube-system, infra
 * namespace list, infra-namespace regex) tag cluster-plumbing as infrastructure.
 */
export function categorize(
  workload: CategorizableWorkload,
  config: CategorizeConfig,
  override: WorkloadCategory | undefined,
): WorkloadCategory {
  if (override) return override;
  const labels = workload.labels ?? {};
  if (labels["app.kubernetes.io/component"] === "celeste-hyper") return "infrastructure";
  if (labels["app.kubernetes.io/managed-by"] === "Helm" && labels["app.kubernetes.io/part-of"] === "kube-system") {
    return "infrastructure";
  }
  const infraNamespaces = config.infraNamespaces ?? DEFAULT_INFRA_NAMESPACES;
  if (infraNamespaces.includes(workload.namespace)) return "infrastructure";
  // Prefer a precompiled regex (set once per scan); fall back to compiling the string (test path).
  const regex = config.infraRegex !== undefined ? config.infraRegex : compileInfraRegex(config.infraNamespaceRegex ?? DEFAULT_INFRA_NAMESPACE_REGEX);
  if (regex && regex.test(workload.namespace)) return "infrastructure";
  return "application";
}
