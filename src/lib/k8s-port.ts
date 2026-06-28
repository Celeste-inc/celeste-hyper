import type { Subprocess } from "bun";
import type { RunResult, ClusterPod, K8sServiceInfo, ClusterNode, IngressRule, ClusterWorkload, K8sEvent } from "./k8s.ts";
import type { NamespaceCounts } from "../services/namespace-counts.ts";
import type { Hpa } from "../services/hpa.ts";

/**
 * The public surface of `K8s`, mirrored as an interface so consumers depend on the seam,
 * not the concrete kubectl-shelling class. `K8s implements K8sLike`; tests pass fakes.
 */
export interface K8sLike {
  readonly runtime: "k3s" | "docker" | "containerd";
  readonly kubeconfig: string | undefined;
  readonly defaultNamespace: string;
  kubectl(args: string[], stdin?: string): Promise<RunResult>;
  importImage(tarPath: string): Promise<RunResult>;
  applyManifest(yaml: string, namespace?: string): Promise<RunResult>;
  applyFile(file: string, namespace?: string): Promise<RunResult>;
  upsertSecretFromEnvFile(name: string, file: string, namespace: string): Promise<RunResult>;
  upsertConfigMapFromEnvFile(name: string, file: string, namespace: string): Promise<RunResult>;
  rolloutStatus(kind: string, name: string, namespace: string, timeoutSec: number): Promise<RunResult>;
  setImage(
    kind: string,
    workloadName: string,
    containerName: string,
    image: string,
    namespace: string,
  ): Promise<RunResult>;
  getIngressYaml(name: string, namespace: string): Promise<RunResult>;
  namespaceCounts(): Promise<NamespaceCounts>;
  listHpas(namespace: string): Promise<Hpa[]>;
  patchHpa(name: string, namespace: string, mergePatch: string): Promise<RunResult>;
  patchWorkloadStrategy(kind: string, name: string, namespace: string, strategyType: string): Promise<RunResult>;
  getWorkloadJson(kind: string, name: string, namespace: string): Promise<RunResult>;
  deleteWorkload(kind: string, name: string, namespace: string): Promise<RunResult>;
  scaleWorkload(kind: string, name: string, namespace: string, replicas: number): Promise<RunResult>;
  patchServiceSelector(name: string, namespace: string, selector: Record<string, string>): Promise<RunResult>;
  getReadyReplicas(kind: string, name: string, namespace: string): Promise<number>;
  getWorkloadSelector(kind: string, name: string, namespace: string): Promise<string | null>;
  listPods(namespace: string, labelSelector?: string): Promise<ClusterPod[]>;
  listEvents(namespace: string, fieldSelector?: string): Promise<K8sEvent[]>;
  getServiceInfo(name: string, namespace: string): Promise<K8sServiceInfo | null>;
  listNodes(): Promise<ClusterNode[]>;
  listIngressesFor(svcName: string, namespace: string): Promise<IngressRule[]>;
  streamLogs(pod: string, container: string, namespace: string, tail: number): Subprocess<"ignore", "pipe", "pipe">;
  /** Interactive `kubectl exec -i` (P3.2). Optional so test fakes that don't exercise the terminal can omit it. */
  streamExec?(pod: string, container: string, namespace: string): Subprocess<"pipe", "pipe", "pipe">;
  listAllDeployments(): Promise<ClusterWorkload[]>;
}
