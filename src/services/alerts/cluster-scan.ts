import type { Alert, AlertCategory, AlertSeverity } from "./types.ts";
import { fingerprint, normalizeForFingerprint, normalizeTs, redact } from "./log-scan.ts";

export interface RawContainerState {
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode?: number; message?: string; finishedAt?: string };
  running?: { startedAt?: string };
}

export interface RawPodStatus {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; creationTimestamp?: string; ownerReferences?: { kind?: string; name?: string }[] };
  status?: {
    phase?: string;
    reason?: string;
    conditions?: { type?: string; status?: string; lastTransitionTime?: string }[];
    containerStatuses?: { name?: string; ready?: boolean; restartCount?: number; state?: RawContainerState; lastState?: RawContainerState }[];
  };
}

export interface RawEventItem {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  involvedObject?: { kind?: string; name?: string; namespace?: string };
  lastTimestamp?: string | null;
  eventTime?: string | null;
  firstTimestamp?: string | null;
}

export interface PodObservation {
  pod: string;
  container: string;
  restartCount: number;
}

const WAITING: Record<string, { category: AlertCategory; severity: AlertSeverity; title: string }> = {
  CrashLoopBackOff: { category: "pod-crashloop", severity: "critical", title: "Container em CrashLoopBackOff" },
  ImagePullBackOff: { category: "pod-image", severity: "critical", title: "Falha ao baixar a imagem (ImagePullBackOff)" },
  ErrImagePull: { category: "pod-image", severity: "critical", title: "Falha ao baixar a imagem (ErrImagePull)" },
  CreateContainerConfigError: { category: "pod-crashloop", severity: "critical", title: "Configuração inválida do container" },
  CreateContainerError: { category: "pod-crashloop", severity: "critical", title: "Erro ao criar o container" },
  InvalidImageName: { category: "pod-image", severity: "critical", title: "Nome de imagem inválido" },
  RunContainerError: { category: "pod-crashloop", severity: "critical", title: "Erro ao iniciar o container" },
};

const IGNORED_EVENT_REASONS = new Set(["Pulling", "Pulled", "Created", "Started", "Scheduled", "Killing", "SuccessfulCreate", "ScalingReplicaSet", "SuccessfulDelete"]);
const STARTUP_EVENT_REASONS = new Set(["Unhealthy", "ProbeWarning"]);

export function serviceOf(pod: RawPodStatus): string {
  const labels = pod.metadata?.labels ?? {};
  return labels["app.kubernetes.io/name"] ?? labels.app ?? labels["k8s-app"] ?? (pod.metadata?.name ?? "unknown").replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "");
}

function ageSeconds(iso: string | undefined, now: Date): number {
  if (!iso) return 0;
  return (now.getTime() - new Date(iso).getTime()) / 1000;
}

export function evaluatePods(
  pods: RawPodStatus[],
  previousRestarts: Map<string, number>,
  now: Date,
  notReadyGraceSec: number,
  cluster: string,
): { alerts: Alert[]; observations: PodObservation[] } {
  const alerts: Alert[] = [];
  const observations: PodObservation[] = [];
  const at = now.toISOString();
  for (const pod of pods) {
    const name = pod.metadata?.name;
    const namespace = pod.metadata?.namespace;
    if (!name || !namespace) continue;
    const service = serviceOf(pod);
    const base = { service, namespace, pod: name, cluster, occurredAt: at };
    if (pod.status?.phase === "Succeeded") continue;
    for (const cs of pod.status?.containerStatuses ?? []) {
      const container = cs.name ?? "?";
      const restartCount = cs.restartCount ?? 0;
      observations.push({ pod: name, container, restartCount });
      const waiting = cs.state?.waiting?.reason;
      const waitingRule = waiting ? WAITING[waiting] : undefined;
      if (waitingRule) {
        alerts.push({
          ...base,
          container,
          key: fingerprint("pod", cluster, namespace, service, container, waitingRule.category),
          severity: waitingRule.severity,
          category: waitingRule.category,
          title: waitingRule.title,
          detail: redact([`motivo: ${waiting}`, cs.state?.waiting?.message ?? "", `reinícios: ${restartCount}`, lastTermination(cs.lastState)].filter(Boolean).join("\n")),
          condition: true,
        });
      }
      const lastReason = cs.lastState?.terminated?.reason ?? cs.state?.terminated?.reason;
      const previous = previousRestarts.get(`${namespace}/${name}/${container}`);
      const restarted = previous !== undefined && restartCount > previous;
      if (restarted && lastReason === "OOMKilled") {
        alerts.push({
          ...base,
          container,
          key: fingerprint("oom", cluster, namespace, service, container),
          severity: "critical",
          category: "pod-oom",
          title: "Container reiniciado por falta de memória (OOMKilled)",
          detail: [`reinícios: ${restartCount}`, lastTermination(cs.lastState)].filter(Boolean).join("\n"),
        });
        continue;
      }
      if (restarted && !waitingRule) {
        alerts.push({
          ...base,
          container,
          key: fingerprint("restart", cluster, namespace, service, container),
          severity: "error",
          category: "pod-restart",
          title: `Container reiniciou (${restartCount - previous!} vez(es) desde a última verificação)`,
          detail: [`reinícios: ${restartCount}`, lastTermination(cs.lastState)].filter(Boolean).join("\n"),
        });
      }
    }
    const ready = pod.status?.conditions?.find((c) => c.type === "Ready");
    const notReadyFor = ready && ready.status !== "True" ? ageSeconds(ready.lastTransitionTime, now) : 0;
    const hasWaitingAlert = alerts.some((a) => a.pod === name && a.condition);
    if (!hasWaitingAlert && notReadyFor >= notReadyGraceSec && pod.status?.phase !== "Succeeded") {
      alerts.push({
        ...base,
        key: fingerprint("notready", cluster, namespace, service, name),
        severity: "error",
        category: "pod-not-ready",
        title: `Pod sem ficar pronto há ${Math.round(notReadyFor / 60)} min`,
        detail: [`fase: ${pod.status?.phase ?? "?"}`, pod.status?.reason ? `motivo: ${pod.status.reason}` : ""].filter(Boolean).join("\n"),
        condition: true,
      });
    }
  }
  return { alerts, observations };
}

function lastTermination(state: RawContainerState | undefined): string {
  const t = state?.terminated;
  if (!t) return "";
  return `última finalização: ${t.reason ?? "?"} (exit ${t.exitCode ?? "?"}${t.finishedAt ? ` em ${t.finishedAt}` : ""})`;
}

export function evaluateEvents(
  events: RawEventItem[],
  sinceIso: string | null,
  cluster: string,
  namespace: string,
  serviceForObject: (kind: string, name: string) => string,
  isStarting: (kind: string, name: string) => boolean = () => false,
): { alerts: Alert[]; lastTimestamp: string | null } {
  const alerts: Alert[] = [];
  const since = sinceIso ? normalizeTs(sinceIso) : null;
  let lastTimestamp = since;
  for (const e of events) {
    const raw = e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? null;
    const ts = raw ? normalizeTs(raw) : null;
    if (!ts || (since && ts <= since)) continue;
    if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    if (e.type !== "Warning" || !e.reason || IGNORED_EVENT_REASONS.has(e.reason)) continue;
    const kind = e.involvedObject?.kind ?? "?";
    const object = e.involvedObject?.name ?? "?";
    if (STARTUP_EVENT_REASONS.has(e.reason) && isStarting(kind, object)) continue;
    const service = serviceForObject(kind, object);
    const message = redact(e.message ?? "");
    alerts.push({
      key: fingerprint("event", cluster, namespace, service, e.reason, normalizeForFingerprint(message)),
      severity: e.reason === "FailedScheduling" || e.reason === "Evicted" || e.reason === "OOMKilling" ? "critical" : "error",
      category: "k8s-event",
      service,
      namespace,
      pod: kind === "Pod" ? object : undefined,
      cluster,
      title: `Evento do Kubernetes: ${e.reason}`,
      detail: [`objeto: ${kind}/${object}`, message, e.count && e.count > 1 ? `ocorrências: ${e.count}` : ""].filter(Boolean).join("\n"),
      occurredAt: ts,
    });
  }
  return { alerts, lastTimestamp };
}
