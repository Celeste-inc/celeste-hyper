export type SourceType = "r2-bundle" | "registry-pull" | "git-sync";
export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";
export type RuntimeKind = "auto" | "k3s" | "docker" | "containerd";
export type EnvKind = "config" | "secret";
export type RegistryKind = "dockerhub" | "ghcr" | "acr" | "generic";

export interface MachineToken {
  id: number;
  name: string;
  role: "operator" | "viewer";
  serviceScope: string | null;
  clusterScope: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface Webhook {
  id: number;
  name: string;
  kind: string;
  secretId: string;
  url: string;
  serviceScope: string | null;
  clusterScope: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface R2Settings {
  id?: string;
  name?: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretConfigured: boolean;
}

export type R2Source = Required<Pick<R2Settings, "id" | "name" | "endpoint" | "bucket" | "region" | "accessKeyId" | "secretConfigured">>;

export interface SetupServiceTemplate {
  name: string;
  label: string;
  r2Prefix: string;
  configEnv: string;
  secretEnv: string;
  registered?: boolean;
  currentTag?: string | null;
  service?: Service | null;
}

export interface SetupStatus {
  clusters: Cluster[];
  services: SetupServiceTemplate[];
  r2: R2Settings;
  r2Sources: R2Source[];
}

export interface CrdEntry {
  name: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string;
  namespaced: boolean;
}

export interface CrEntry {
  name: string;
  namespace: string | null;
  createdAt: string | null;
}

export interface ClusterHealth {
  ok: boolean;
  reachable: boolean;
  message?: string;
  checkedAt?: string;
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

export interface PodMetric {
  pod: string;
  container?: string;
  cpuMillicores: number;
  memoryMi: number;
}

export interface PodMetricsSummary {
  podCount: number;
  totalCpuMillicores: number;
  totalMemoryMi: number;
  avgCpuMillicores: number;
  avgMemoryMi: number;
}

export interface PodMetricsResponse {
  pods: PodMetric[];
  summary: PodMetricsSummary;
}

export interface PurgeFailure {
  resource: string;
  reason: string;
}

export interface PurgeResult {
  removed: string[];
  failed: PurgeFailure[];
  planned: string[];
}

export interface DeleteServiceResponse {
  ok: true;
  purge: PurgeResult;
}

export interface TemplateEnvSpec {
  key: string;
  description?: string;
  default?: string;
  required?: boolean;
  secret?: boolean;
}

export interface Template {
  id: string;
  label: string;
  category: "web" | "cache" | "database" | "queue" | "proxy";
  image: string;
  defaultTag: string;
  defaultPort: number;
  portName: string;
  description: string;
  env: TemplateEnvSpec[];
  recommendedAutoscale?: { minReplicas: number; maxReplicas: number; targetCPUUtilizationPercentage: number };
}

export interface DockerHubImage {
  name: string;
  description: string;
  stars: number;
  pulls: number;
  official: boolean;
}

export interface TemplateDeployResponse {
  service: { name: string };
  deploymentId: number;
  applied: Array<{ kind: string; name: string; namespace: string }>;
  loadBalancer: { kind: string; replicas: number; message: string };
}

export type RegistryPresetId = "ghcr" | "acr" | "docker-hub" | "quay" | "harbor" | "ecr";

export interface RegistryPreset {
  id: RegistryPresetId;
  label: string;
  host: string;
  hostExample: string;
  requiresRegistry: boolean;
  omitHostInImageRef: boolean;
  auth: { usernameLabel: string; passwordLabel: string; hint?: string };
}

export interface RegistrySourceSummary {
  id: string;
  name: string;
  presetId: RegistryPresetId;
  registry?: string;
  region?: string;
  username: string;
  email?: string;
  secretConfigured: boolean;
}

export interface RegistrySourceInput {
  id: string;
  name: string;
  presetId: RegistryPresetId;
  registry?: string;
  region?: string;
  username: string;
  password?: string;
  email?: string;
}

export interface PreflightResult {
  applicable: boolean;
  ok?: boolean;
  reason?: string;
}

export interface RollbackPreview {
  eligible: boolean;
  previousTag: string | null;
  previousRevision: number | null;
  source: "hyper" | "cluster" | null;
  reason?: string;
}

export interface HelmInfo {
  release: string;
  namespace: string;
  chart: string | null;
  version: string | null;
  upgradeable: boolean;
  valuesRedacted: unknown;
}

export interface Capability {
  value: boolean;
  source: "cluster" | "host";
  lastCheckedAt: string;
  error?: string;
}

export interface Cluster {
  id: string;
  name: string;
  kubeconfigPath?: string;
  defaultNamespace: string;
  runtime: RuntimeKind;
  enabled: boolean;
  health?: ClusterHealth;
  serviceCount: number;
  /** Merged cluster + host capability records (P0.8); the UI gates affordances on these. */
  capabilities?: Record<string, Capability>;
  capabilitiesCheckedAt?: string | null;
  /** kubectl<->apiserver version skew (CC.5). `versionSkew.ok` is false when out of the ±1-minor policy. */
  kubectlVersion?: string | null;
  serverVersion?: string | null;
  versionSkew?: { client: string | null; server: string | null; ok: boolean; reason: string | null };
}

export interface EnvRow {
  key: string;
  value: string;
  description?: string;
}

export interface EnvSummary {
  path: string;
  exists: boolean;
  keys: string[];
  rows?: { key: string; description?: string }[];
  content?: string;
}

export interface ContainerSummary {
  name: string;
  image: string;
  ready?: boolean;
  restartCount?: number;
  waitingReason?: string;
  terminatedReason?: string;
}

export interface WorkloadSummary {
  clusterId: string;
  kind: WorkloadKind;
  namespace: string;
  name: string;
  replicas: number;
  readyReplicas: number;
  managed?: boolean;
  containers: ContainerSummary[];
}

export interface ServiceClusterSummary {
  kind: WorkloadKind;
  replicas: number;
  readyReplicas: number;
  containers: ContainerSummary[];
}

export type DeployMode = "rolling" | "recreate" | "canary" | "blue-green";

export interface BaseService {
  name: string;
  namespace: string;
  clusterId: string;
  sourceType: SourceType;
  enabled: boolean;
  deployMode?: DeployMode;
  canaryConfig?: { replicas: number; observationSec: number; successThreshold: number };
  healthGate?: { attempts: number; intervalSec: number; successThreshold: number };
  /** Opt-in: on a failed health gate, auto-enqueue a (grace-delayed) rollback (P1.9). */
  autoRollback?: boolean;
  /** Opt-in: saving config.env / secret.env via the UI enqueues a redeploy at the current tag. */
  autoRedeployOnEnv?: boolean;
  /** Optional Service object the hyper provisions in front of the workload. */
  expose?: ExposeConfig;
}

export interface ExposeConfig {
  type: "ClusterIP" | "NodePort" | "LoadBalancer";
  port: number;
  targetPort?: number | string;
  nodePort?: number;
  protocol: "TCP" | "UDP";
}

export interface AutoRollbackStatus {
  pending: { id: number; nextAttemptAt: string } | null;
  degraded: { reason: string; at: string } | null;
}

export interface R2Service extends BaseService {
  sourceType: "r2-bundle";
  r2SourceId?: string;
  r2Prefix: string;
  manifestRoot?: string;
  imageTarPattern?: string;
  imageRefPrefix?: string;
}

export interface RegistryService extends BaseService {
  sourceType: "registry-pull";
  imageRef: string;
  workloadKind: WorkloadKind;
  workloadName?: string;
  containerName?: string;
  imagePullSecret?: string;
  helmRelease?: string;
  helmChartRef?: string;
  helmImageTagValuePath?: string;
}

export interface GitSyncService extends BaseService {
  sourceType: "git-sync";
  gitUrl: string;
  gitRef: string;
  gitPath: string;
  deployKeyPath?: string;
}

export type Service = R2Service | RegistryService | GitSyncService;

export type ServiceListItem = Service & {
  currentTag: string | null;
  deployedAt: string | null;
  env: {
    config: EnvSummary;
    secret: EnvSummary;
  };
  cluster: ServiceClusterSummary | null;
  newVersion: string | null;
  activeDeployment?: { status: string; started_at?: string; finished_at?: string | null } | null;
};

export interface ServicesResponse {
  items: ServiceListItem[];
  unmanaged: WorkloadSummary[];
  infrastructure?: WorkloadSummary[];
  lastTickAt?: string;
}

export interface SystemResponse {
  clusters: number;
  r2: {
    endpoint?: string;
    bucket?: string;
  };
  poller: {
    enabled: boolean;
    intervalSec: number;
    autoDeploy: boolean;
    lastTickAt?: string;
    lastDurationMs?: number;
    lastError?: string;
  };
}

export interface Deployment {
  id: number;
  service: string;
  tag: string;
  status: "pending" | "downloading" | "applying" | "done" | "failed" | string;
  message?: string;
  started_at?: string;
  finished_at?: string;
  action?: "deploy" | "rollback";
  health_gate_result?: string | null;
}

export interface VersionItem {
  tag: string;
  imageSize?: number;
  lastModified?: string;
}

export interface VersionsResponse {
  items: VersionItem[];
  source: "r2" | "registry";
  rateLimited?: boolean;
  authRequired?: boolean;
  hint?: string | null;
  total?: number;
}

export interface PodSummary {
  name: string;
  phase: string;
  podIP?: string;
  nodeName?: string;
  containers: ContainerSummary[];
}

export interface PodGroup {
  workload: string;
  kind: string;
  role: "primary" | "related";
  selector: string;
  pods: PodSummary[];
  error?: string;
}

export interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  involvedObject: { kind: string; name: string };
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  count: number;
}

export interface ServicePort {
  name?: string;
  protocol: string;
  port: number;
  targetPort?: number | string | null;
  nodePort?: number;
}

export type DnsHint =
  | { resolved: true; addresses: string[]; elapsedMs: number }
  | { resolved: false; reason: string };

export interface Endpoint {
  kind: "cluster-ip" | "node-port" | "ingress" | "load-balancer";
  url: string;
  description: string;
  copyable: boolean;
  reachableFromHost?: boolean;
  source?: { kind: "ingress"; ingressName: string; ingressNamespace: string };
  dns?: DnsHint;
}

export interface NetworkingService {
  name: string;
  type: string;
  clusterIP?: string;
  externalIPs?: string[];
  ports: ServicePort[];
  endpoints?: Endpoint[];
}

export interface DiscoveryCandidate {
  ip: string;
  port: number;
  reachable: boolean;
  serverVersion: string | null;
  distribution: "k3s" | "k8s" | "microk8s" | "rke2" | "unknown";
  authMethods: string[];
  ms: number;
}

export interface DiscoveryScanResult {
  candidates: DiscoveryCandidate[];
  tuplesScanned: number;
  ipsScanned: number;
  timedOut: boolean;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  role: string | null;
  action: string;
  resource_kind: string | null;
  resource_id: string | null;
  payload: string | null;
  result: "ok" | "fail" | string;
  message: string | null;
}

export interface AuditPage {
  items: AuditRow[];
  nextCursor: string | null;
}

export interface ApiResult<T> {
  status: number;
  body: T;
}

export interface ApiErrorBody {
  error?: string;
  issues?: unknown;
}
