import type { Alert, AlertCategory, AlertSeverity } from "./types.ts";

export interface SlackMessage {
  text: string;
  blocks: Record<string, unknown>[];
}

export interface SlackSendResult {
  ok: boolean;
  status: number;
  attempts: number;
  error?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;

const SEVERITY: Record<AlertSeverity, { emoji: string; label: string }> = {
  critical: { emoji: ":red_circle:", label: "CRÍTICO" },
  error: { emoji: ":large_orange_circle:", label: "ERRO" },
  warning: { emoji: ":large_yellow_circle:", label: "ATENÇÃO" },
};

const CATEGORY_LABEL: Record<AlertCategory, string> = {
  "app-error": "Erro de aplicação",
  "pod-crashloop": "Container em loop de falha",
  "pod-oom": "Falta de memória",
  "pod-image": "Imagem indisponível",
  "pod-not-ready": "Pod indisponível",
  "pod-restart": "Reinício de container",
  "k8s-event": "Evento do Kubernetes",
  "deploy-failed": "Deploy",
  "service-degraded": "Serviço degradado",
  "env-drift": "Configuração (env)",
  "hyper-error": "Plataforma (Hyper)",
  "watcher-error": "Monitoramento",
};

const MAX_CODE = 2600;

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function code(text: string): string {
  const escaped = escape(text).replace(/```/g, "'''");
  if (escaped.length <= MAX_CODE) return "```" + escaped + "```";
  const cut = escaped.slice(0, MAX_CODE).replace(/&[a-z]*$/, "");
  return "```" + cut + "\n… (truncado)```";
}

export function formatTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
}

export function alertTags(alert: Alert, environment: string): string[] {
  const tags = [environment, alert.service, alert.category, alert.severity, alert.namespace, ...(alert.tags ?? [])]
    .filter((t): t is string => Boolean(t))
    .map((t) => t.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-"));
  return [...new Set(tags)];
}

export function buildAlertMessage(
  alert: Alert,
  ctx: { environment: string; timeZone: string; occurrences: number; firstSeen: string; suppressed: number },
): SlackMessage {
  const sev = SEVERITY[alert.severity];
  const tags = alertTags(alert, ctx.environment);
  const where = [alert.namespace, alert.pod].filter(Boolean).join(" / ");
  const fields = [
    `*Serviço*\n${escape(alert.service)}`,
    `*Ambiente*\n${escape(ctx.environment)}`,
    `*Categoria*\n${CATEGORY_LABEL[alert.category]}`,
    `*Severidade*\n${sev.label}`,
  ];
  if (where) fields.push(`*Namespace / Pod*\n${escape(where)}`);
  if (alert.container) fields.push(`*Container*\n${escape(alert.container)}`);
  fields.push(`*Ocorrências*\n${ctx.occurrences}${ctx.suppressed > 0 ? ` (${ctx.suppressed} agrupada(s) desde o último aviso)` : ""}`);
  fields.push(`*Primeira ocorrência*\n${formatTime(ctx.firstSeen, ctx.timeZone)}`);
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: `${sev.emoji} ${sev.label} · ${alert.service}`.slice(0, 150), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${escape(alert.title.slice(0, 600))}*` } },
    { type: "section", fields: fields.slice(0, 10).map((text) => ({ type: "mrkdwn", text })) },
  ];
  if (alert.detail.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: code(alert.detail) } });
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: tags.map((t) => `\`#${t}\``).join(" ") },
      { type: "mrkdwn", text: `${formatTime(alert.occurredAt, ctx.timeZone)} · cluster ${escape(alert.cluster ?? "local")} · id ${alert.key.slice(0, 12)}` },
    ],
  });
  blocks.push({ type: "divider" });
  return { text: `${sev.label} · ${alert.service} · ${alert.title}`.slice(0, 300), blocks };
}

export function buildResolvedMessage(
  record: { key: string; service: string; title: string; category: AlertCategory; firstSeen: string; total: number },
  ctx: { environment: string; timeZone: string; resolvedAt: string },
): SlackMessage {
  const tags = [ctx.environment, record.service, record.category, "resolvido"].map((t) => `\`#${t.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}\``).join(" ");
  return {
    text: `RESOLVIDO · ${record.service} · ${record.title}`.slice(0, 300),
    blocks: [
      { type: "header", text: { type: "plain_text", text: `:white_check_mark: RESOLVIDO · ${record.service}`.slice(0, 150), emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `*${escape(record.title.slice(0, 600))}*\nAtivo desde ${formatTime(record.firstSeen, ctx.timeZone)} · ${record.total} verificação(ões) com problema` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `${tags} · resolvido em ${formatTime(ctx.resolvedAt, ctx.timeZone)} · id ${record.key.slice(0, 12)}` }] },
      { type: "divider" },
    ],
  };
}

export function buildOverflowMessage(dropped: Alert[], ctx: { environment: string; timeZone: string; now: string }): SlackMessage {
  const lines = dropped.slice(0, 25).map((a) => `• ${SEVERITY[a.severity].emoji} *${escape(a.service)}* · ${escape(a.title.slice(0, 100))}`);
  if (dropped.length > 25) lines.push(`… e mais ${dropped.length - 25}`);
  return {
    text: `${dropped.length} alerta(s) adicionais agrupados`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `:rotating_light: ${dropped.length} alerta(s) adicionais neste ciclo`, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n").slice(0, 2900) } },
      { type: "context", elements: [{ type: "mrkdwn", text: `\`#${ctx.environment}\` \`#alertas-agrupados\` · limite por ciclo atingido · ${formatTime(ctx.now, ctx.timeZone)}` }] },
      { type: "divider" },
    ],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postToSlack(
  url: string,
  message: SlackMessage,
  opts: { fetch?: FetchLike; maxAttempts?: number; timeoutMs?: number; delay?: (ms: number) => Promise<void> } = {},
): Promise<SlackSendResult> {
  const doFetch = opts.fetch ?? (fetch as unknown as FetchLike);
  const maxAttempts = opts.maxAttempts ?? 3;
  const delay = opts.delay ?? sleep;
  let status = 0;
  let error: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
    try {
      const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message), signal: controller.signal });
      status = res.status;
      if (res.ok) return { ok: true, status, attempts: attempt };
      error = (await res.text().catch(() => "")).slice(0, 200);
      if (status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        await delay(Math.min(Math.max(retryAfter, 1), 30) * 1000);
        continue;
      }
      if (status < 500) return { ok: false, status, attempts: attempt, error };
    } catch (e) {
      error = (e as Error).name === "AbortError" ? "timeout" : (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) await delay(Math.min(1000 * 2 ** (attempt - 1), 8000));
  }
  return { ok: false, status, attempts: maxAttempts, error };
}
