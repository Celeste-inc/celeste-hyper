import { createHash } from "node:crypto";

export interface LogFinding {
  timestamp: string;
  level: string;
  message: string;
  detail: string;
  fingerprint: string;
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

function parseJsonLine(body: string): { level: string; message: string; detail: string } | null {
  if (!body.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const level = (pick(obj, JSON_LEVEL_KEYS) ?? "").toLowerCase();
  if (!ERROR_LEVELS.has(level)) return null;
  const message = pick(obj, JSON_MESSAGE_KEYS) ?? "error";
  const detail = JSON_DETAIL_KEYS
    .filter((k) => obj[k] !== undefined && obj[k] !== message)
    .map((k) => `${k}: ${typeof obj[k] === "string" ? obj[k] : JSON.stringify(obj[k])}`)
    .join("\n");
  return { level, message, detail };
}

const CRITICAL_META = /"severity"\s*:\s*"critical"/i;

const WINSTON = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)? \[(\w+)\]: (.*?)(?: (\{.*\}))?$/;

function parseTextLine(body: string): { level: string; message: string; detail: string } | null {
  for (const { level, re } of TEXT_PATTERNS) {
    if (!re.test(body)) continue;
    const resolved = CRITICAL_META.test(body) ? "critical" : level;
    const w = WINSTON.exec(body);
    if (w) return { level: resolved, message: w[2] || body, detail: w[3] ? prettyMeta(w[3]) : "" };
    return { level: resolved, message: body, detail: "" };
  }
  return null;
}

function prettyMeta(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([k]) => k !== "service")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
  } catch {
    return raw;
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
      findings.push(makeFinding(timestamp, json.level, json.message, json.detail));
      continue;
    }
    const text = parseTextLine(body);
    if (text) findings.push(makeFinding(timestamp, text.level, text.message, text.detail));
  }
  return { findings, lastTimestamp };
}

function makeFinding(timestamp: string, level: string, message: string, detail: string): LogFinding {
  const cleanMessage = redact(message).slice(0, 500);
  return {
    timestamp,
    level,
    message: cleanMessage,
    detail: redact(detail).slice(0, MAX_DETAIL),
    fingerprint: normalizeForFingerprint(cleanMessage),
  };
}
