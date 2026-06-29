import { z } from "zod";

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

export const ClusterRuntimeSchema = z.enum(["auto", "k3s", "docker", "containerd"]);

export const ClusterModelSchema = z.object({
  id: z.string().min(1).regex(ID_RE, "lowercase letters, digits, dot, dash"),
  name: z.string().min(1),
  kubeconfigPath: z.string().min(1),
  defaultNamespace: z.string().min(1).default("default"),
  runtime: ClusterRuntimeSchema.default("auto"),
  description: z.string().optional(),
  accessHost: z.string().optional(),
  enabled: z.boolean().default(true),
  infraNamespaces: z.array(z.string()).optional(),
  infraNamespaceRegex: z.string().optional(),
});
export type ClusterModel = z.infer<typeof ClusterModelSchema>;

export const CreateClusterSchema = ClusterModelSchema;
export const UpdateClusterSchema = ClusterModelSchema.partial();

export const DeployModeSchema = z.enum(["rolling", "recreate", "canary", "blue-green"]);
export type DeployMode = z.infer<typeof DeployModeSchema>;
export const CanaryConfigSchema = z.object({
  replicas: z.number().int().min(1).default(1),
  observationSec: z.number().int().min(1).default(60),
  successThreshold: z.number().int().min(1).default(3),
});
export const HealthGateSchema = z.object({
  attempts: z.number().int().min(1).default(6),
  intervalSec: z.number().int().min(1).default(5),
  successThreshold: z.number().int().min(1).default(3),
  // Active sampleProbe (http/tcp/exec) is a documented follow-up — not wired yet, so it is not
  // accepted here rather than silently ignored. The gate uses Kubernetes readiness/restart signals.
});

// Sibling workloads (e.g. a worker Deployment alongside the primary API) that the operator wants
// to see grouped under THIS service in the UI — same namespace + cluster as the parent. Purely
// informational: hyper does not deploy or roll them out (the bundle's own manifests do that);
// it only aggregates pods, events, and logs so the operator has a single page per logical app.
//
// Constraints kept narrow so a typo doesn't accidentally pull in unrelated cluster workloads:
//   - same cluster + namespace as the parent (no cross-namespace grouping)
//   - max 8 entries (prevents UI overload + bounds the kubectl fan-out per request)
//   - kind: same set as RegistryPullSchema.workloadKind (Deployment | StatefulSet | DaemonSet)
//   - containerName is optional; logs default to the workload's first container when absent.
export const RelatedWorkloadSchema = z.object({
  name: z.string().min(1).regex(ID_RE, "lowercase letters, digits, dot, dash"),
  kind: z.enum(["Deployment", "StatefulSet", "DaemonSet"]).default("Deployment"),
  containerName: z.string().min(1).regex(ID_RE, "lowercase letters, digits, dot, dash").optional(),
});
export type RelatedWorkload = z.infer<typeof RelatedWorkloadSchema>;

// Minimal Service object the hyper provisions on the operator's behalf — covers the common
// "expose this workload on port X" case without requiring a hand-written Service yaml in the
// bundle. Set on a service to enable; omit to keep manifests authoritative.
export const ExposeSchema = z.object({
  type: z.enum(["ClusterIP", "NodePort", "LoadBalancer"]).default("ClusterIP"),
  port: z.number().int().min(1).max(65535),
  targetPort: z.union([z.number().int().min(1).max(65535), z.string().min(1).max(63)]).optional(), // string = named container port
  nodePort: z.number().int().min(30000).max(32767).optional(), // ignored unless type=NodePort; range matches k8s default
  protocol: z.enum(["TCP", "UDP"]).default("TCP"),
});
export type ExposeConfig = z.infer<typeof ExposeSchema>;

const BaseService = {
  name: z.string().min(1).regex(ID_RE, "lowercase letters, digits, dot, dash"),
  namespace: z.string().min(1).default("default"),
  clusterId: z.string().min(1).regex(ID_RE),
  containerName: z.string().regex(ID_RE, "lowercase letters, digits, dot, dash").optional(), // also kept safe for the verify jsonpath
  enabled: z.boolean().default(true),
  deployMode: DeployModeSchema.optional(), // absent = rolling (read as `deployMode ?? "rolling"`)
  canaryConfig: CanaryConfigSchema.optional(),
  healthGate: HealthGateSchema.optional(), // absent = no steady-state gate (opt-in)
  autoRollback: z.boolean().optional(), // opt-in: on a failed health gate, auto-enqueue a rollback
  // Helm release ops (P2.2): all three required to enable the "Helm upgrade" path. We never guess
  // the image-tag values key — the operator supplies its dotted path. These flow into the `helm`
  // argv, so they're constrained to reject a leading `-` (helm flag injection, e.g. --post-renderer
  // is RCE) and the `--set` separators (`,`/`=`/whitespace).
  helmRelease: z.string().min(1).max(253).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "invalid release name").optional(),
  helmChartRef: z.string().min(1).max(512).regex(/^[A-Za-z0-9._/][A-Za-z0-9._/:@+-]*$/, "invalid chart ref").optional(),
  helmImageTagValuePath: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.[\]]*$/, "invalid values path").optional(),
  // Opt-in: persisting config.env / secret.env via the UI enqueues a redeploy at the current tag.
  // Off by default — the operator triggers via Deploy as usual.
  autoRedeployOnEnv: z.boolean().optional(),
  // Optional Service object the hyper provisions in front of the workload; see ExposeSchema.
  expose: ExposeSchema.optional(),
  // Sibling workloads aggregated under this service in the UI; see RelatedWorkloadSchema.
  relatedWorkloads: z.array(RelatedWorkloadSchema).max(8).optional(),
};

export const R2BundleSchema = z.object({
  ...BaseService,
  sourceType: z.literal("r2-bundle"),
  r2SourceId: z.string().min(1).regex(ID_RE, "lowercase letters, digits, dot, dash").optional(),
  r2Prefix: z.string().min(1),
  manifestRoot: z.string().default("k8s"),
  imageTarPattern: z.string().default("{name}-{tag}-amd64.tar"),
  imageRefPrefix: z.string().default("docker.io/library"),
});
export type R2BundleService = z.infer<typeof R2BundleSchema>;

export const RegistryPullSchema = z.object({
  ...BaseService,
  sourceType: z.literal("registry-pull"),
  imageRef: z.string().min(1),
  imagePullSecret: z.string().optional(),
  workloadKind: z.enum(["Deployment", "StatefulSet", "DaemonSet"]).default("Deployment"),
  workloadName: z.string().optional(),
});
export type RegistryPullService = z.infer<typeof RegistryPullSchema>;

export const GitSyncSchema = z.object({
  ...BaseService,
  sourceType: z.literal("git-sync"),
  gitUrl: z.string().min(1).max(512),
  // `--branch <ref>` puts the ref before the `--` separator, so it must not look like a flag; this
  // also matches git's own ref-name rules (no leading `-`, no `..`, no spaces/control/glob chars).
  gitRef: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "invalid git ref").default("main"),
  gitPath: z.string().default("."), // repo-relative manifest dir; traversal-validated at the route
  deployKeyPath: z.string().optional(),
});
export type GitSyncService = z.infer<typeof GitSyncSchema>;

export const ServiceModelSchema = z.discriminatedUnion("sourceType", [
  R2BundleSchema,
  RegistryPullSchema,
  GitSyncSchema,
]);
export type ServiceModel = z.infer<typeof ServiceModelSchema>;

export const CreateServiceSchema = ServiceModelSchema;
export const UpdateServiceSchema = z.union([
  R2BundleSchema.partial().extend({ sourceType: z.literal("r2-bundle") }),
  RegistryPullSchema.partial().extend({ sourceType: z.literal("registry-pull") }),
  GitSyncSchema.partial().extend({ sourceType: z.literal("git-sync") }),
]);

export function workloadNameFor(svc: ServiceModel): string {
  if (svc.sourceType === "registry-pull") return svc.workloadName ?? svc.name;
  return svc.name;
}

export function workloadKindFor(svc: ServiceModel): string {
  return svc.sourceType === "registry-pull" ? svc.workloadKind : "Deployment";
}

export function containerNameFor(svc: ServiceModel): string {
  return svc.containerName ?? svc.name;
}

export function relatedWorkloadsFor(svc: ServiceModel): RelatedWorkload[] {
  // Dedup by (kind, name) so a stray duplicate in the spec doesn't double-fetch pods/events/logs.
  const seen = new Set<string>();
  const out: RelatedWorkload[] = [];
  for (const r of svc.relatedWorkloads ?? []) {
    const key = `${r.kind}:${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
