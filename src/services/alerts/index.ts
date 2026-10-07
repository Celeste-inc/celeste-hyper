import type { Config } from "../../config.ts";
import type { State } from "../../lib/state.ts";
import type { Registry } from "../registry.ts";
import type { K8sPool } from "../k8s-pool.ts";
import type { JobRow } from "../../queue/queue.ts";
import type { Alert } from "./types.ts";
import { AlertManager } from "./manager.ts";
import { AlertWatcher, type WatchTarget } from "./watcher.ts";
import { fingerprint, normalizeForFingerprint, redact } from "./log-scan.ts";
import { log, setLogSink } from "../../lib/logger.ts";

export interface Alerting {
  manager: AlertManager;
  watcher: AlertWatcher;
  onJobOutcome(job: JobRow, result: "ok" | "fail", message?: string): void;
  start(): void;
  stop(): Promise<void>;
}

const JOB_TITLES: Record<string, string> = {
  deploy: "Deploy falhou",
  rollback: "Rollback falhou — serviço pode estar degradado",
  "helm-upgrade": "Upgrade Helm falhou",
};

const SILENT_EVENTS = /^(alerts\.|logger\.)/;

export function envWarnings(message: string | null | undefined): string[] {
  if (!message) return [];
  return message.split(" · ").filter((w) => w.startsWith("[warn]") && /(drift|both config\.env and secret\.env|only in the cluster|guard failed|drift check skipped)/.test(w));
}

export function createAlerting(deps: { cfg: Config; state: State; registry: Registry; pool: K8sPool }): Alerting | null {
  const cfg = deps.cfg.alerts;
  if (!cfg.enabled || !cfg.slackWebhookUrl) {
    log.info("alerts.disabled", { reason: cfg.enabled ? "no slack webhook configured" : "disabled in config" });
    return null;
  }
  const manager = new AlertManager({
    webhookUrl: cfg.slackWebhookUrl,
    environment: cfg.environment,
    timeZone: cfg.timeZone,
    cooldownSec: cfg.cooldownSec,
    maxPerCycle: cfg.maxPerCycle,
    store: deps.state,
  });
  const targets = (): WatchTarget[] => [
    ...deps.registry.list().filter((s) => s.enabled).map((s) => ({ clusterId: s.clusterId, namespace: s.namespace })),
    ...cfg.namespaces,
  ];
  const ignore = cfg.ignore.map((p) => new RegExp(p, "i"));
  const retentionMs = cfg.retentionDays * 86_400_000;
  let lastHousekeeping = 0;
  const watcher = new AlertWatcher({
    manager,
    targets,
    k8s: (id) => deps.pool.get(id),
    cursors: deps.state,
    intervalSec: cfg.intervalSec,
    notReadyGraceSec: cfg.notReadyGraceSec,
    logs: cfg.logs,
    events: cfg.events,
    maxLogBytes: cfg.maxLogBytes,
    maxFindingsPerContainer: cfg.maxFindingsPerContainer,
    ignore,
    housekeeping: () => {
      const now = Date.now();
      if (now - lastHousekeeping < 3_600_000) return;
      lastHousekeeping = now;
      const cutoff = new Date(now - retentionMs).toISOString();
      deps.state.pruneAlerts(cutoff);
      deps.state.pruneCursors(cutoff);
    },
  });

  const enqueue = (alert: Omit<Alert, "occurredAt" | "cluster"> & { cluster?: string }) => {
    const full: Alert = { cluster: "local", ...alert, occurredAt: new Date().toISOString() };
    if (ignore.some((re) => re.test(`${full.service} ${full.title} ${full.detail}`))) return;
    manager.enqueue(full);
  };

  const serviceNamespace = (name: string) => deps.registry.get(name)?.namespace;

  const onJobOutcome = (job: JobRow, result: "ok" | "fail", message?: string) => {
    const service = job.resource_id;
    if (result === "fail") {
      const category = job.kind === "rollback" ? "service-degraded" : "deploy-failed";
      enqueue({
        key: fingerprint("job", job.kind, service, normalizeForFingerprint(message ?? "")),
        severity: "critical",
        category,
        service,
        namespace: serviceNamespace(service),
        title: JOB_TITLES[job.kind] ?? `Job ${job.kind} falhou`,
        detail: redact([`job: ${job.kind} #${job.id}`, `tentativas: ${job.attempts}/${job.max_attempts}`, message ?? job.last_error ?? ""].filter(Boolean).join("\n")),
        tags: ["deploy", job.kind],
      });
      return;
    }
    if (job.kind !== "deploy") return;
    const warnings = envWarnings(deps.state.deploymentById(job.id)?.message);
    if (!warnings.length) return;
    enqueue({
      key: fingerprint("envdrift", service, normalizeForFingerprint(warnings.join("|"))),
      severity: "warning",
      category: "env-drift",
      service,
      namespace: serviceNamespace(service),
      title: "Deploy concluído com avisos de configuração (env)",
      detail: redact(warnings.join("\n")),
      tags: ["deploy", "env"],
    });
  };

  return {
    manager,
    watcher,
    onJobOutcome,
    start() {
      setLogSink((_level, event, fields) => {
        if (SILENT_EVENTS.test(event)) return;
        const detail = redact(Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n"));
        enqueue({
          key: fingerprint("hyper", event, normalizeForFingerprint(String(fields.service ?? ""))),
          severity: "error",
          category: "hyper-error",
          service: typeof fields.service === "string" ? fields.service : "celeste-hyper",
          title: `Erro na plataforma Hyper: ${event}`,
          detail,
          tags: ["hyper"],
        });
      });
      watcher.start();
    },
    async stop() {
      setLogSink(null);
      await watcher.stop();
      await manager.stop();
    },
  };
}
