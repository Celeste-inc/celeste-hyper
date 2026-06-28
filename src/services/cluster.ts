import type { ClusterWorkload } from "../lib/k8s.ts";
import type { K8sLike } from "../lib/k8s-port.ts";
import type { Registry } from "./registry.ts";
import type { ClusterModel } from "./model.ts";
import { categorize, compileInfraRegex, DEFAULT_INFRA_NAMESPACE_REGEX, type WorkloadCategory } from "./categorize.ts";
import { log } from "../lib/logger.ts";

export interface DiscoveredWorkload extends ClusterWorkload {
  clusterId: string;
  managed: boolean;
  category: WorkloadCategory;
  suggestedName: string;
  suggestedImageRef: string;
}

function parseImage(image: string): { ref: string; tag: string } {
  const at = image.lastIndexOf("@");
  const sep = at >= 0 ? at : image.lastIndexOf(":");
  if (sep <= 0 || (image.indexOf("/", sep) >= 0)) return { ref: image, tag: "latest" };
  return { ref: image.slice(0, sep), tag: image.slice(sep + 1) };
}

export async function discoverWorkloads(
  cluster: ClusterModel,
  k8s: K8sLike,
  registry: Registry,
  overrides: Map<string, string>,
): Promise<DiscoveredWorkload[]> {
  const items = await k8s.listAllDeployments();
  const managed = new Set(
    registry.listByCluster(cluster.id).map((s) => `${s.namespace}/${s.name}`),
  );
  // Compile the infra-namespace regex once per scan (not per workload); fall back to the default
  // and warn if the operator's pattern is invalid.
  const regexSrc = cluster.infraNamespaceRegex ?? DEFAULT_INFRA_NAMESPACE_REGEX;
  let infraRegex = compileInfraRegex(regexSrc);
  if (infraRegex === null) {
    log.warn("categorize.invalid_regex", { clusterId: cluster.id, regex: regexSrc });
    infraRegex = compileInfraRegex(DEFAULT_INFRA_NAMESPACE_REGEX);
  }
  const config = { infraNamespaces: cluster.infraNamespaces, infraRegex };
  return items.map((w) => {
    const c0 = w.containers[0]!;
    const { ref } = parseImage(c0.image);
    const override = overrides.get(`${w.namespace}/${w.kind}/${w.name}`) as WorkloadCategory | undefined;
    return {
      ...w,
      clusterId: cluster.id,
      managed: managed.has(`${w.namespace}/${w.name}`),
      category: categorize(w, config, override),
      suggestedName: w.name,
      suggestedImageRef: ref,
    };
  });
}
