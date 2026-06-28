import type {
  ApiErrorBody,
  ApiResult,
  AuditPage,
  AutoRollbackStatus,
  Cluster,
  ClusterHealth,
  CrdEntry,
  CrEntry,
  Deployment,
  DiscoveryScanResult,
  EnvKind,
  EnvRow,
  EnvSummary,
  K8sEvent,
  HelmInfo,
  HpaView,
  MachineToken,
  NetworkingService,
  PodSummary,
  PreflightResult,
  RegistryKind,
  R2Source,
  R2Settings,
  RollbackPreview,
  Service,
  ServicesResponse,
  SetupStatus,
  SetupServiceTemplate,
  SystemResponse,
  VersionsResponse,
  Webhook,
} from "../types/api";

let csrfToken: string | null = null;
/** Set from `/api/me`; attached as X-CSRF-Token on cookie-auth mutations (P0.5). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T & ApiErrorBody>> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (csrfToken && method !== "GET" && method !== "HEAD") headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body } as ApiResult<T & ApiErrorBody>;
}

export interface MeResponse {
  username: string;
  role: string;
  mustChangePassword: boolean;
  csrfToken: string | null;
}

export const http = {
  me: () => api<MeResponse>("/me"),
  login: (username: string, password: string) => json<MeResponse>("/login", "POST", { username, password }),
  changePassword: (currentPassword: string, newPassword: string) =>
    json<{ ok: true }>("/change-password", "POST", { currentPassword, newPassword }),
  logout: () => api<{ ok: true }>("/logout", { method: "POST" }),
  clusters: () => api<{ items: Cluster[] }>("/clusters"),
  system: () => api<SystemResponse>("/system"),
  services: () => api<ServicesResponse>("/services"),
  service: (name: string) => api<{ service: Service; currentTag: string | null; deployedAt: string | null }>(`/services/${encodeURIComponent(name)}`),
  createCluster: (body: unknown) => json<{ cluster: Cluster }>("/clusters", "POST", body),
  updateCluster: (id: string, body: unknown) => json<{ cluster: Cluster }>(`/clusters/${encodeURIComponent(id)}`, "PATCH", body),
  deleteCluster: (id: string) => api<{ ok: true }>(`/clusters/${encodeURIComponent(id)}`, { method: "DELETE" }),
  checkCluster: (id: string) => api<{ health: ClusterHealth }>(`/clusters/${encodeURIComponent(id)}/check`, { method: "POST" }),
  setWorkloadOverride: (clusterId: string, body: { namespace: string; kind: string; name: string; category: "application" | "infrastructure" }) =>
    json<{ ok: true }>(`/clusters/${encodeURIComponent(clusterId)}/workload-overrides`, "POST", body),
  createService: (body: unknown) => json<{ service: Service }>("/services", "POST", body),
  adoptService: (body: unknown) => json<{ service: Service }>("/services/adopt", "POST", body),
  updateService: (name: string, body: unknown) => json<{ service: Service }>(`/services/${encodeURIComponent(name)}`, "PATCH", body),
  deleteService: (name: string) => api<{ ok: true }>(`/services/${encodeURIComponent(name)}`, { method: "DELETE" }),
  versions: (name: string) => api<VersionsResponse>(`/services/${encodeURIComponent(name)}/versions`),
  deployments: (name: string) => api<{ items: Deployment[] }>(`/services/${encodeURIComponent(name)}/deployments`),
  deployment: (id: number) => api<{ deployment: Deployment }>(`/deployments/${id}`),
  deploy: (name: string, tag: string) => json<{ deploymentId: number; accepted: boolean }>(`/services/${encodeURIComponent(name)}/deploy`, "POST", { tag }),
  preflight: (name: string, tag: string) => api<PreflightResult>(`/services/${encodeURIComponent(name)}/preflight?tag=${encodeURIComponent(tag)}`),
  rollbackPreview: (name: string) => api<RollbackPreview>(`/services/${encodeURIComponent(name)}/rollback`),
  rollback: (name: string) => json<{ jobId: number; accepted: boolean }>(`/services/${encodeURIComponent(name)}/rollback`, "POST", {}),
  autoRollbackStatus: (name: string) => api<AutoRollbackStatus>(`/services/${encodeURIComponent(name)}/auto-rollback`),
  cancelAutoRollback: (name: string) => json<{ cancelled: boolean; jobId: number }>(`/services/${encodeURIComponent(name)}/auto-rollback/cancel`, "POST", {}),
  undegrade: (name: string) => json<{ cleared: boolean }>(`/services/${encodeURIComponent(name)}/undegrade`, "POST", {}),
  env: (name: string, kind: EnvKind) => api<EnvSummary>(`/services/${encodeURIComponent(name)}/env/${kind}${kind === "config" ? "?reveal=true" : ""}`),
  saveEnv: (name: string, kind: EnvKind, content: string) => json<{ ok: true }>(`/services/${encodeURIComponent(name)}/env/${kind}`, "PUT", { content }),
  saveEnvRows: (name: string, kind: EnvKind, rows: EnvRow[]) =>
    json<{ ok: true; stripped: string[] }>(`/services/${encodeURIComponent(name)}/env/${kind}/rows`, "PUT", { rows }),
  logToken: (name: string) => json<{ token: string; expiresAt: string }>(`/services/${encodeURIComponent(name)}/logs/token`, "POST", {}),
  execToken: (name: string, pod: string, container: string) =>
    json<{ token: string; expiresAt: string }>("/services/" + encodeURIComponent(name) + "/exec/token", "POST", { pod, container }),
  pods: (name: string) => api<{ items: PodSummary[]; selector?: string; error?: string }>(`/services/${encodeURIComponent(name)}/pods`),
  events: (name: string) => api<{ items: K8sEvent[]; error?: string }>(`/services/${encodeURIComponent(name)}/events`),
  networking: (name: string) => api<{ service: NetworkingService | null; hint?: string }>(`/services/${encodeURIComponent(name)}/networking`),
  ingressYaml: (clusterId: string, namespace: string, name: string) =>
    api<{ yaml: string }>(`/clusters/${encodeURIComponent(clusterId)}/ingresses/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`),
  crds: (clusterId: string) => api<{ items: CrdEntry[] }>("/clusters/" + encodeURIComponent(clusterId) + "/crds"),
  crObjects: (clusterId: string, resource: string, namespace?: string) =>
    api<{ items: CrEntry[] }>("/clusters/" + encodeURIComponent(clusterId) + "/crds/" + encodeURIComponent(resource) + "/objects" + (namespace ? "?namespace=" + encodeURIComponent(namespace) : "")),
  crYaml: (clusterId: string, resource: string, name: string, namespace?: string) =>
    api<{ yaml: string }>("/clusters/" + encodeURIComponent(clusterId) + "/crds/" + encodeURIComponent(resource) + "/objects/" + encodeURIComponent(name) + "/yaml" + (namespace ? "?namespace=" + encodeURIComponent(namespace) : "")),
  hpa: (name: string) => api<{ hpa: HpaView | null }>(`/services/${encodeURIComponent(name)}/hpa`),
  patchHpa: (name: string, body: { min?: number; max?: number; targetCPUUtilizationPercentage?: number }) =>
    json<{ hpa: HpaView | null }>(`/services/${encodeURIComponent(name)}/hpa`, "PATCH", body),
  helm: (name: string) => api<{ helm: HelmInfo | null }>("/services/" + encodeURIComponent(name) + "/helm"),
  helmUpgrade: (name: string, tag: string) => json<{ deploymentId: number; accepted: boolean }>("/services/" + encodeURIComponent(name) + "/helm/upgrade", "POST", { tag }),
  machineTokens: () => api<{ items: MachineToken[] }>("/machine-tokens"),
  createMachineToken: (body: { name: string; role: MachineToken["role"]; serviceScope?: string | null; clusterScope?: string | null; expiresInDays?: number | null }) =>
    json<{ token: string; machineToken: MachineToken }>("/machine-tokens", "POST", body),
  revokeMachineToken: (id: number) => api<{ revoked: boolean }>("/machine-tokens/" + id, { method: "DELETE" }),
  webhooks: () => api<{ items: Webhook[] }>("/webhooks"),
  createWebhook: (body: { name: string; kind: RegistryKind; serviceScope?: string | null; clusterScope?: string | null }) =>
    json<{ secret: string; webhook: Webhook }>("/webhooks", "POST", body),
  revokeWebhook: (id: number) => api<{ revoked: boolean }>("/webhooks/" + id, { method: "DELETE" }),
  scanDiscovery: (body: { targets: string[]; ports?: number[]; timeoutMs?: number; consent: string }) =>
    json<DiscoveryScanResult>("/discovery/scan", "POST", body),
  audit: (qs: string) => api<AuditPage>("/audit" + (qs ? "?" + qs : "")),
  setupStatus: () => api<SetupStatus>("/setup/status"),
  setupServices: () => api<{ items: SetupServiceTemplate[] }>("/setup/services"),
  bootstrapSetup: (body: { clusterId: string; namespace: string; services: Array<Pick<SetupServiceTemplate, "name" | "r2Prefix" | "configEnv" | "secretEnv">>; r2SourceId?: string; writeEnvTemplates: boolean; overwriteEnvTemplates: boolean }) =>
    json<{ items: { service: string; action: string; env: { config: string; secret: string } }[] }>("/setup/bootstrap", "POST", body),
  r2Sources: () => api<{ items: R2Source[] }>("/settings/r2/sources"),
  saveR2Source: (body: { id: string; name: string; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey?: string }) =>
    json<R2Source>("/settings/r2/sources", "POST", body),
  deleteR2Source: (id: string) => api<{ ok: true }>("/settings/r2/sources/" + encodeURIComponent(id), { method: "DELETE" }),
  testR2Source: (id: string) => json<{ ok: boolean; bucket: string; prefixes: string[] }>("/settings/r2/sources/" + encodeURIComponent(id) + "/test", "POST", {}),
  r2Settings: () => api<R2Settings>("/settings/r2"),
  saveR2Settings: (body: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey?: string }) =>
    json<R2Settings>("/settings/r2", "PUT", body),
  testR2Settings: (body?: { id?: string; name?: string; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey?: string }) =>
    json<{ ok: boolean; bucket: string; prefixes: string[] }>("/settings/r2/test", "POST", body ?? {}),
};

function json<T>(path: string, method: "POST" | "PATCH" | "PUT", body: unknown): Promise<ApiResult<T & ApiErrorBody>> {
  return api<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
