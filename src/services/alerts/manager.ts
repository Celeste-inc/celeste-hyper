import type { Alert, AlertRecord, AlertStore } from "./types.ts";
import { buildAlertMessage, buildOverflowMessage, buildResolvedMessage, postToSlack, type FetchLike, type SlackMessage } from "./slack.ts";
import { log } from "../../lib/logger.ts";

export interface AlertManagerOptions {
  webhookUrl: string;
  environment: string;
  timeZone: string;
  cooldownSec: number;
  maxPerCycle: number;
  store: AlertStore;
  now?: () => Date;
  fetch?: FetchLike;
  delay?: (ms: number) => Promise<void>;
}

export interface CycleResult {
  sent: number;
  suppressed: number;
  resolved: number;
  overflow: number;
  failed: number;
}

const SEVERITY_RANK = { critical: 0, error: 1, warning: 2 } as const;

export function scopeOf(alert: Pick<Alert, "cluster" | "namespace">): string {
  return `${alert.cluster ?? "local"}/${alert.namespace ?? "-"}`;
}

export class AlertManager {
  private pending: Alert[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: AlertManagerOptions) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  enqueue(alert: Alert): void {
    this.pending.push(alert);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending.splice(0);
      void this.runCycle(batch, null);
    }, 2000);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const batch = this.pending.splice(0);
    if (batch.length) await this.runCycle(batch, null);
    await this.chain;
  }

  runCycle(alerts: Alert[], scannedScopes: Set<string> | null): Promise<CycleResult> {
    const next = this.chain.then(() => this.cycle(alerts, scannedScopes));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async send(message: SlackMessage): Promise<boolean> {
    const res = await postToSlack(this.opts.webhookUrl, message, { fetch: this.opts.fetch, delay: this.opts.delay });
    if (!res.ok) log.warn("alerts.slack_failed", { status: res.status, attempts: res.attempts, reason: res.error });
    return res.ok;
  }

  private async cycle(alerts: Alert[], scannedScopes: Set<string> | null): Promise<CycleResult> {
    const result: CycleResult = { sent: 0, suppressed: 0, resolved: 0, overflow: 0, failed: 0 };
    const now = this.now();
    const nowIso = now.toISOString();
    const cooldownMs = this.opts.cooldownSec * 1000;
    const unique = new Map<string, Alert>();
    for (const a of alerts) if (!unique.has(a.key)) unique.set(a.key, a);
    const seenConditions = new Set<string>();
    const toSend: { alert: Alert; record: AlertRecord }[] = [];

    for (const alert of unique.values()) {
      const existing = this.opts.store.getAlert(alert.key);
      const record: AlertRecord = existing
        ? { ...existing, severity: alert.severity, title: alert.title, lastSeen: nowIso, total: existing.total + 1, open: true }
        : {
            key: alert.key,
            severity: alert.severity,
            category: alert.category,
            service: alert.service,
            title: alert.title,
            scope: scopeOf(alert),
            firstSeen: nowIso,
            lastSeen: nowIso,
            lastSent: null,
            suppressed: 0,
            total: 1,
            open: true,
            condition: Boolean(alert.condition),
          };
      if (alert.condition) seenConditions.add(alert.key);
      const reopened = existing !== null && !existing.open;
      const due = !record.lastSent || reopened || now.getTime() - new Date(record.lastSent).getTime() >= cooldownMs;
      if (due) {
        if (reopened) record.firstSeen = nowIso;
        toSend.push({ alert, record });
      } else {
        record.suppressed += 1;
        result.suppressed += 1;
      }
      this.opts.store.saveAlert(record);
    }

    toSend.sort((a, b) => SEVERITY_RANK[a.alert.severity] - SEVERITY_RANK[b.alert.severity]);
    const direct = toSend.slice(0, this.opts.maxPerCycle);
    const overflow = toSend.slice(this.opts.maxPerCycle);

    for (const { alert, record } of direct) {
      const message = buildAlertMessage(alert, {
        environment: this.opts.environment,
        timeZone: this.opts.timeZone,
        occurrences: record.total,
        firstSeen: record.firstSeen,
        suppressed: record.suppressed,
      });
      if (await this.send(message)) {
        this.opts.store.saveAlert({ ...record, lastSent: nowIso, suppressed: 0 });
        result.sent += 1;
      } else {
        result.failed += 1;
      }
    }

    if (overflow.length) {
      const ok = await this.send(buildOverflowMessage(overflow.map((o) => o.alert), { environment: this.opts.environment, timeZone: this.opts.timeZone, now: nowIso }));
      if (ok) {
        for (const { record } of overflow) this.opts.store.saveAlert({ ...record, lastSent: nowIso, suppressed: 0 });
        result.overflow = overflow.length;
      } else {
        result.failed += overflow.length;
      }
    }

    if (scannedScopes) {
      for (const open of this.opts.store.openConditions()) {
        if (seenConditions.has(open.key) || !scannedScopes.has(open.scope)) continue;
        const closed = { ...open, open: false };
        if (!open.lastSent) {
          this.opts.store.saveAlert(closed);
          continue;
        }
        if (await this.send(buildResolvedMessage(open, { environment: this.opts.environment, timeZone: this.opts.timeZone, resolvedAt: nowIso }))) {
          this.opts.store.saveAlert(closed);
          result.resolved += 1;
        }
      }
    }

    if (result.sent || result.overflow || result.resolved || result.failed) log.info("alerts.cycle", { ...result });
    return result;
  }
}
