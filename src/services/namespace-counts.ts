export interface NamespaceInfo {
  name: string;
  phase: string;
  createdAt: string; // ISO; the UI renders "age" from this
  deploymentCount: number;
  statefulsetCount: number;
  daemonsetCount: number;
  podCount: number;
}

export interface NamespaceCounts {
  items: NamespaceInfo[];
  /** True if the pod scan hit its cap and per-namespace pod counts may be undercounts. */
  truncated: boolean;
}

const KIND_FIELD: Record<string, keyof NamespaceInfo> = {
  Deployment: "deploymentCount",
  StatefulSet: "statefulsetCount",
  DaemonSet: "daemonsetCount",
};

/**
 * Pure aggregation of per-namespace counts from three already-fetched lists:
 * the namespace objects, one namespace string per pod, and `{kind, namespace}` per workload.
 * Namespaces with no pods/workloads report zeros. Sorted by name.
 */
export function aggregateNamespaces(
  namespaces: Array<{ name: string; phase: string; createdAt: string }>,
  podNamespaces: string[],
  workloads: Array<{ kind: string; namespace: string }>,
): NamespaceInfo[] {
  const byName = new Map<string, NamespaceInfo>();
  for (const ns of namespaces) {
    byName.set(ns.name, {
      name: ns.name,
      phase: ns.phase,
      createdAt: ns.createdAt,
      deploymentCount: 0,
      statefulsetCount: 0,
      daemonsetCount: 0,
      podCount: 0,
    });
  }
  for (const ns of podNamespaces) {
    const info = byName.get(ns);
    if (info) info.podCount += 1;
  }
  for (const w of workloads) {
    const info = byName.get(w.namespace);
    const field = KIND_FIELD[w.kind];
    if (info && field) (info[field] as number) += 1;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
