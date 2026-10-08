import { createHash } from "node:crypto";

export interface ErrorClassification {
  code: string;
  title?: string;
  cause?: string;
  action?: string;
  component?: string;
}

export interface LogFinding {
  timestamp: string;
  level: string;
  message: string;
  detail: string;
  fingerprint: string;
  classification?: ErrorClassification;
}

const CLASSIFICATION_KEYS = new Set(["error_code", "error_title", "probable_cause", "suggested_action", "component", "service"]);

export function extractClassification(obj: Record<string, unknown>): ErrorClassification | undefined {
  const code = typeof obj.error_code === "string" ? obj.error_code.trim() : "";
  if (!/^[A-Z][A-Z0-9-]{2,80}$/.test(code)) return undefined;
  const text = (k: string) => (typeof obj[k] === "string" && (obj[k] as string).trim() ? redact(obj[k] as string).slice(0, 400) : undefined);
  return { code, title: text("error_title"), cause: text("probable_cause"), action: text("suggested_action"), component: text("component") };
}

const ANSI = /\u001b\[[0-9;]*m/g;
const ERROR_LEVELS = new Set(["error", "err", "critical", "crit", "fatal", "emerg", "emergency", "alert", "panic", "severe"]);
const JSON_LEVEL_KEYS = ["level", "levelname", "severity", "lvl", "log.level"];
const JSON_MESSAGE_KEYS = ["event", "msg", "message", "error", "err"];
const JSON_DETAIL_KEYS = ["exception", "exc_info", "stack", "stacktrace", "error", "err", "reason", "detail", "path", "job", "job_type", "id"];
const TEXT_PATTERNS: { level: string; re: RegExp }[] = [
  { level: "error", re: /\[(error|crit|alert|emerg)\][:\s]/i },
  { level: "error", re: /^(?:\S+\s+){0,3}(ERROR|CRITICAL|FATAL|SEVERE)\s*[:[\s]/ },
  { level: "error", re: /^(ERROR|CRITICAL|FATAL):/ },
  { level: "error", re: /^\s*(panic:|fatal error:|Unhandled(?:PromiseRejection)?|UnhandledPromiseRejectionWarning)/i },
];
const TRACEBACK = /^Traceback \(most recent call last\):/;
const STACK_CONTINUATION = /^(\s+|[A-Za-z_][\w.]*(Error|Exception|Warning)\b|During handling|The above exception)/;
const MAX_DETAIL = 1800;

const REDACTIONS: [RegExp, string][] = [
  [/https:\/\/hooks\.slack\.com\/services\/\S+/gi, "https://hooks.slack.com/services/***"],
  [/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1***:***@"],
  [/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/("?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|access[_-]?key|client[_-]?secret|private[_-]?key)"?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi, "$1***"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "***jwt***"],
  [/((?:set-)?cookie"?\s*[=:]\s*)[^\n]+/gi, "$1***"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1***"],
  [/\b(sk|pk|rk|xox[abprs])-[A-Za-z0-9-]{10,}/g, "$1-***"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "***"],
  [/\b[A-Za-z0-9+/]{48,}={0,2}/g, "***"],
];

export function normalizeTs(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(ts);
  if (!m) return ts;
  if (m[3] !== "Z") {
    const d = new Date(`${m[1]}${m[3]}`);
    if (Number.isNaN(d.getTime())) return ts;
    return `${d.toISOString().slice(0, 19)}.${(m[2] ?? "").padEnd(9, "0").slice(0, 9)}Z`;
  }
  return `${m[1]}.${(m[2] ?? "").padEnd(9, "0").slice(0, 9)}Z`;
}

export function redact(text: string): string {
  return REDACTIONS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

export function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?(z|[+-]\d{2}:?\d{2})?\b/g, "<ts>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function fingerprint(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

function splitTimestamp(line: string): { timestamp: string; body: string } {
  const space = line.indexOf(" ");
  const head = space > 0 ? line.slice(0, space) : "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(head)) return { timestamp: normalizeTs(head), body: line.slice(space + 1) };
  return { timestamp: "", body: line };
}

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function parseJsonLine(body: string): { level: string; message: string; detail: string; classification?: ErrorClassification } | null {
  if (!body.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const level = (pick(obj, JSON_LEVEL_KEYS) ?? "").toLowerCase();
  if (!ERROR_LEVELS.has(level)) return null;
  const classification = extractClassification(obj);
  const message = classification?.title ?? pick(obj, JSON_MESSAGE_KEYS) ?? "error";
  const detailKeys = classification ? [...JSON_DETAIL_KEYS, "technical", "event", "job", "contact_id", "job_id", "path"] : JSON_DETAIL_KEYS;
  const detail = [...new Set(detailKeys)]
    .filter((k) => obj[k] !== undefined && obj[k] !== message && !CLASSIFICATION_KEYS.has(k))
    .map((k) => `${k}: ${typeof obj[k] === "string" ? obj[k] : JSON.stringify(obj[k])}`)
    .join("\n");
  return { level, message, detail, classification };
}

const CRITICAL_META = /"severity"\s*:\s*"critical"/i;

const WINSTON = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)? \[(\w+)\]: (.*?)(?: (\{.*\}))?$/;

function parseTextLine(body: string): { level: string; message: string; detail: string; classification?: ErrorClassification } | null {
  for (const { level, re } of TEXT_PATTERNS) {
    if (!re.test(body)) continue;
    const resolved = CRITICAL_META.test(body) ? "critical" : level;
    const w = WINSTON.exec(body);
    if (!w) return { level: resolved, message: body, detail: "" };
    const meta = w[3] ? parseMeta(w[3]) : null;
    if (!meta) return { level: resolved, message: w[2] || body, detail: w[3] ?? "" };
    const classification = extractClassification(meta);
    const detail = Object.entries(meta)
      .filter(([k]) => !CLASSIFICATION_KEYS.has(k) && k !== "severity")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
    return { level: resolved, message: w[2] || body, detail, classification };
  }
  return null;
}

function parseMeta(raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function scanLogLines(lines: string[], since: string | null): { findings: LogFinding[]; lastTimestamp: string | null } {
  const findings: LogFinding[] = [];
  since = since ? normalizeTs(since) : null;
  let lastTimestamp = since;
  let i = 0;
  while (i < lines.length) {
    const { timestamp, body: rawBody } = splitTimestamp(lines[i]!);
    i++;
    if (timestamp && since && timestamp <= since) continue;
    if (timestamp && (!lastTimestamp || timestamp > lastTimestamp)) lastTimestamp = timestamp;
    const body = rawBody.replace(ANSI, "").trimEnd();
    if (!body) continue;
    if (TRACEBACK.test(body)) {
      const block = [body];
      while (i < lines.length && block.length < 40) {
        const next = splitTimestamp(lines[i]!).body.replace(ANSI, "").trimEnd();
        if (!STACK_CONTINUATION.test(next)) break;
        block.push(next);
        i++;
      }
      const last = block[block.length - 1]!;
      findings.push(makeFinding(timestamp, "error", `Traceback: ${last}`, block.join("\n")));
      continue;
    }
    const json = parseJsonLine(body);
    if (json) {
      findings.push(makeFinding(timestamp, json.level, json.message, json.detail, json.classification));
      continue;
    }
    const text = parseTextLine(body);
    if (text) findings.push(makeFinding(timestamp, text.level, text.message, text.detail, text.classification));
  }
  return { findings, lastTimestamp };
}

function makeFinding(timestamp: string, level: string, message: string, detail: string, classification?: ErrorClassification): LogFinding {
  const cleanMessage = redact(message).slice(0, 500);
  return {
    timestamp,
    level,
    message: cleanMessage,
    detail: redact(detail).slice(0, MAX_DETAIL),
    fingerprint: classification ? `code:${classification.code}` : normalizeForFingerprint(cleanMessage),
    classification,
  };
}
