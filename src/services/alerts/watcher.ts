import type { K8sLike } from "../../lib/k8s-port.ts";
import type { Alert } from "./types.ts";
import type { AlertManager } from "./manager.ts";
import { evaluateEvents, evaluatePods, serviceOf, type RawEventItem, type RawPodStatus } from "./cluster-scan.ts";
import { fingerprint, scanLogLines, type LogFinding } from "./log-scan.ts";
import { log } from "../../lib/logger.ts";

export interface WatchTarget {
  clusterId: string;
  namespace: string;
}

export interface AlertWatcherOptions {
  manager: AlertManager;
  targets: () => WatchTarget[];
  k8s: (clusterId: string) => K8sLike | null;
  cursors: { getCursor(key: string): string | null; setCursor(key: string, value: string): void };
  intervalSec: number;
  notReadyGraceSec: number;
  logs: boolean;
  events: boolean;
  maxLogBytes: number;
  maxFindingsPerContainer: number;
  ignore: RegExp[];
  housekeeping?: () => void;
  now?: () => Date;
}

const CRITICAL_LEVELS = new Set(["critical", "crit", "fatal", "emerg", "emergency", "alert", "panic"]);
const KUBECTL_TIMEOUT = "--request-timeout=20s";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} excedeu ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]!.slice(0, 160);
}

export class AlertWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running: Promise<void> | null = null;
  private readonly restarts = new Map<string, number>();

  constructor(private readonly opts: AlertWatcherOptions) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    log.info("alerts.watcher_start", { intervalSec: this.opts.intervalSec, logs: this.opts.logs, events: this.opts.events });
    this.schedule(5_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }

  private freshCursor(cursor: string | null, now: Date): string {
    const floor = new Date(now.getTime() - this.opts.intervalSec * 2000);
    if (!cursor) return floor.toISOString();
    const parsed = new Date(cursor);
    if (Number.isNaN(parsed.getTime()) || now.getTime() - parsed.getTime() > this.opts.intervalSec * 10_000) return floor.toISOString();
    return cursor;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((e) => log.warn("alerts.watcher_tick_failed", { error: (e as Error).message }))
        .finally(() => {
          this.running = null;
          this.schedule(this.opts.intervalSec * 1000);
        });
    }, ms);
  }

  async tick(): Promise<void> {
    const alerts: Alert[] = [];
    const scanned = new Set<string>();
    const seen = new Set<string>();
    for (const target of this.opts.targets()) {
      const scope = `${target.clusterId}/${target.namespace}`;
      if (seen.has(scope)) continue;
      seen.add(scope);
      const k8s = this.opts.k8s(target.clusterId);
      if (!k8s) continue;
      try {
        alerts.push(...(await withTimeout(this.scanNamespace(k8s, target), this.opts.intervalSec * 2000, `varredura de ${target.namespace}`)));
        scanned.add(scope);
      } catch (e) {
        alerts.push({
          key: fingerprint("watcher", scope),
          severity: "error",
          category: "watcher-error",
          service: "celeste-hyper",
          cluster: target.clusterId,
          namespace: target.namespace,
          title: `Monitoramento não conseguiu ler o namespace ${target.namespace}`,
          detail: (e as Error).message.slice(0, 1000),
          condition: true,
          occurredAt: this.now().toISOString(),
        });
      }
    }
    const filtered = alerts.filter((a) => !this.opts.ignore.some((re) => re.test(`${a.service} ${a.title} ${a.detail}`)));
    await this.opts.manager.runCycle(filtered, scanned);
    this.opts.housekeeping?.();
  }

  private async scanNamespace(k8s: K8sLike, target: WatchTarget): Promise<Alert[]> {
    const { clusterId, namespace } = target;
    const now = this.now();
    const podsRes = await k8s.kubectl([KUBECTL_TIMEOUT, "-n", namespace, "get", "pods", "-o", "json"]);
    if (podsRes.code !== 0) throw new Error(`kubectl get pods: ${(podsRes.stderr || podsRes.stdout).trim().slice(0, 300)}`);
    const pods = (JSON.parse(podsRes.stdout) as { items?: RawPodStatus[] }).items ?? [];
    const prior = new Map<string, number>();
    for (const [k, v] of this.restarts) if (k.startsWith(`${clusterId}|`)) prior.set(k.slice(clusterId.length + 1), v);
    const { alerts, observations } = evaluatePods(pods, prior, now, this.opts.notReadyGraceSec, clusterId);
    const restartedNow = new Set<string>();
    for (const o of observations) {
      const key = `${clusterId}|${namespace}/${o.pod}/${o.container}`;
      const before = this.restarts.get(key);
      if (before !== undefined && o.restartCount > before) restartedNow.add(`${o.pod}/${o.container}`);
      this.restarts.set(key, o.restartCount);
    }
    const livePods = new Set(pods.map((p) => p.metadata?.name).filter(Boolean));
    for (const key of [...this.restarts.keys()]) {
      if (!key.startsWith(`${clusterId}|${namespace}/`)) continue;
      const pod = key.slice(`${clusterId}|${namespace}/`.length).split("/")[0]!;
      if (!livePods.has(pod)) this.restarts.delete(key);
    }

    if (this.opts.events) {
      const evRes = await k8s.kubectl([KUBECTL_TIMEOUT, "-n", namespace, "get", "events", "-o", "json"]);
      if (evRes.code === 0) {
        const cursorKey = `events:${clusterId}/${namespace}`;
        const since = this.freshCursor(this.opts.cursors.getCursor(cursorKey), now);
        const items = (JSON.parse(evRes.stdout) as { items?: RawEventItem[] }).items ?? [];
        const byPod = new Map(pods.map((p) => [p.metadata?.name ?? "", serviceOf(p)]));
        const createdAt = new Map(pods.map((p) => [p.metadata?.name ?? "", Date.parse(p.metadata?.creationTimestamp ?? "")]));
        const starting = (kind: string, name: string) => {
          if (kind !== "Pod") return false;
          const created = createdAt.get(name);
          if (created === undefined || Number.isNaN(created)) return true;
          return now.getTime() - created < this.opts.notReadyGraceSec * 1000;
        };
        const ev = evaluateEvents(items, since, clusterId, namespace, (kind, name) => (kind === "Pod" && byPod.get(name)) || name.replace(/-[a-z0-9]{8,10}(-[a-z0-9]{5})?$/, ""), starting);
        alerts.push(...ev.alerts);
        if (ev.lastTimestamp) this.opts.cursors.setCursor(cursorKey, ev.lastTimestamp);
      }
    }

    if (this.opts.logs) {
      for (const pod of pods) {
        const name = pod.metadata?.name;
        if (!name || pod.status?.phase === "Pending") continue;
        const service = serviceOf(pod);
        for (const cs of pod.status?.containerStatuses ?? []) {
          const container = cs.name ?? "";
          if (!container) continue;
          const cursorKey = `logs:${clusterId}/${namespace}/${name}/${container}`;
          const cursor = this.opts.cursors.getCursor(cursorKey);
          const since = this.freshCursor(cursor, now);
          const findings: LogFinding[] = [];
          const restarts = cs.restartCount ?? 0;
          const prevKey = `prev:${clusterId}/${namespace}/${name}/${container}`;
          const crashWaiting = Boolean(cs.state?.waiting) && restarts > 0;
          if ((restartedNow.has(`${name}/${container}`) || crashWaiting) && this.opts.cursors.getCursor(prevKey) !== String(restarts)) {
            const prev = await k8s.kubectl([KUBECTL_TIMEOUT, "-n", namespace, "logs", name, "-c", container, "--previous", "--timestamps", "--tail=300"]);
            if (prev.code === 0) findings.push(...scanLogLines(prev.stdout.split("\n"), null).findings.slice(-this.opts.maxFindingsPerContainer));
            this.opts.cursors.setCursor(prevKey, String(restarts));
          }
          if (cs.state?.running || cs.state?.terminated) {
            const res = await k8s.kubectl([KUBECTL_TIMEOUT, "-n", namespace, "logs", name, "-c", container, "--timestamps", `--since-time=${since}`, `--limit-bytes=${this.opts.maxLogBytes}`]);
            if (res.code === 0) {
              const scan = scanLogLines(res.stdout.split("\n"), since);
              findings.push(...scan.findings.slice(-this.opts.maxFindingsPerContainer));
              const truncated = Buffer.byteLength(res.stdout) >= this.opts.maxLogBytes * 0.98;
              if (truncated) log.warn("alerts.log_backlog_skipped", { namespace, pod: name, container });
              this.opts.cursors.setCursor(cursorKey, truncated ? now.toISOString() : scan.lastTimestamp ?? since);
            }
          }
          for (const f of findings) {
            alerts.push({
              key: fingerprint("log", clusterId, namespace, service, container, f.fingerprint),
              severity: CRITICAL_LEVELS.has(f.level) ? "critical" : "error",
              category: "app-error",
              service,
              namespace,
              pod: name,
              container,
              cluster: clusterId,
              title: `Erro registrado em ${service}: ${firstLine(f.message)}`,
              detail: [f.classification ? "" : f.message, f.detail].filter(Boolean).join("\n\n"),
              tags: ["log", f.level, ...(f.classification ? [f.classification.code] : [])],
              errorCode: f.classification?.code,
              probableCause: f.classification?.cause,
              suggestedAction: f.classification?.action,
              occurredAt: f.timestamp || now.toISOString(),
            });
          }
        }
      }
    }
    return alerts;
  }
}
