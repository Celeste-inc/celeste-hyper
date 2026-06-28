import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { log } from "./logger.ts";

export type EnvKind = "config" | "secret";

export interface EnvRow {
  key: string;
  value: string;
  description?: string;
}

const VALID_KEY = /^[A-Z_][A-Z0-9_]*$/;
// Disallowed control chars to strip on serialize (keep \t \n \r, which we escape).
const STRIP_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export interface EnvFiles {
  rootDir: string;
}

export function pathFor(root: string, service: string, kind: EnvKind): string {
  return join(root, service, `${kind}.env`);
}

export async function read(root: string, service: string, kind: EnvKind): Promise<string> {
  const p = pathFor(root, service, kind);
  if (!existsSync(p)) return "";
  return (await readFile(p)).toString();
}

export async function write(root: string, service: string, kind: EnvKind, content: string): Promise<void> {
  const p = pathFor(root, service, kind);
  await mkdir(join(root, service), { recursive: true });
  const mode = kind === "secret" ? 0o600 : 0o644;
  // Unpredictable tmp name (no symlink pre-creation) created directly at the target mode (no
  // world-readable window), then atomically renamed so a crash mid-write can't corrupt the env.
  const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, { mode });
  try {
    await rename(tmp, p);
  } catch (e) {
    await unlink(tmp).catch(() => {}); // don't leave a stray (possibly secret) tmp behind
    throw e;
  }
  log.info("env.written", { service, kind, path: p });
}

// ── dotenv rows <-> text (P1.6) ──────────────────────────────────────
function findClosingDquote(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

function unescapeDquote(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_m, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
}

/**
 * Parse dotenv text into ordered rows: unquoted / single-quoted (literal) / double-quoted (with
 * `\n \t \r \" \\` escapes and multi-line) values. A `#` comment block directly above a key becomes
 * that row's `description`. Throws on a duplicate key (surfaced as a specific error).
 */
export function parseRows(content: string): EnvRow[] {
  const rows: EnvRow[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  let comments: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "") {
      comments = [];
      continue;
    }
    if (line.startsWith("#")) {
      comments.push(line.slice(1).trim());
      continue;
    }
    const eq = raw.indexOf("=");
    const keyPart = eq >= 0 ? raw.slice(0, eq).trim() : "";
    if (eq < 0 || !VALID_KEY.test(keyPart)) {
      comments = [];
      continue;
    }
    const rest = raw.slice(eq + 1);
    let value: string;
    if (rest.startsWith('"')) {
      const collected: string[] = [];
      let buf = rest.slice(1);
      for (;;) {
        const end = findClosingDquote(buf);
        if (end >= 0) {
          collected.push(buf.slice(0, end));
          break;
        }
        collected.push(buf);
        i++;
        if (i >= lines.length) break;
        buf = lines[i]!;
      }
      value = unescapeDquote(collected.join("\n"));
    } else if (rest.startsWith("'")) {
      // Single-quoted = literal. Close on the LAST quote so an embedded apostrophe in a
      // hand-edited file (`'it''s'`) isn't silently truncated. (We only ever emit double quotes.)
      const end = rest.lastIndexOf("'");
      value = end > 0 ? rest.slice(1, end) : rest.slice(1);
    } else {
      value = rest.trim();
    }
    if (seen.has(keyPart)) throw new Error(`duplicate key: ${keyPart}`);
    seen.add(keyPart);
    rows.push(comments.length ? { key: keyPart, value, description: comments.join("\n") } : { key: keyPart, value });
    comments = [];
  }
  return rows;
}

function quoteIfNeeded(v: string): string {
  if (v === "") return "";
  if (/[\n\r\t"#=]/.test(v) || /^\s|\s$/.test(v)) {
    const escaped = v
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return v;
}

/** Serialize rows to dotenv text. Strips disallowed control chars and reports the affected keys. */
export function serializeRows(rows: EnvRow[]): { content: string; stripped: string[] } {
  const stripped: string[] = [];
  const out: string[] = [];
  for (const row of rows) {
    const cleaned = row.value.replace(STRIP_CONTROL, "");
    if (cleaned !== row.value) stripped.push(row.key);
    if (row.description) for (const dl of row.description.split("\n")) out.push(`# ${dl}`);
    out.push(`${row.key}=${quoteIfNeeded(cleaned)}`);
  }
  return { content: out.length ? out.join("\n") + "\n" : "", stripped };
}

/** Row-level validation for the structured PUT: empty/invalid keys and duplicates. */
export function rowErrors(rows: EnvRow[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.key) errors.push("empty key");
    else if (!VALID_KEY.test(r.key)) errors.push(`invalid key: ${r.key}`);
    if (r.key) {
      if (seen.has(r.key)) errors.push(`duplicate key: ${r.key}`);
      seen.add(r.key);
    }
  }
  return errors;
}

export interface EnvSummary {
  service: string;
  kind: EnvKind;
  path: string;
  exists: boolean;
  keys: string[];
  /** Key + optional description per row (no values — safe for the secret kind too). */
  rows: { key: string; description?: string }[];
}

export async function summary(root: string, service: string, kind: EnvKind): Promise<EnvSummary> {
  const p = pathFor(root, service, kind);
  if (!existsSync(p)) return { service, kind, path: p, exists: false, keys: [], rows: [] };
  const content = (await readFile(p)).toString();
  let rows: EnvRow[];
  try {
    rows = parseRows(content);
  } catch {
    rows = []; // unparseable (e.g. a pre-existing duplicate) — fall back to the key scan below
  }
  const metaRows = rows.map((r) => (r.description ? { key: r.key, description: r.description } : { key: r.key }));
  const keys = rows.length ? rows.map((r) => r.key) : keyScan(content);
  return { service, kind, path: p, exists: true, keys, rows: metaRows };
}

/** Lenient key extraction used as a fallback when full parsing fails. */
function keyScan(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Z_][A-Z0-9_]*)\s*=/.exec(trimmed);
    if (m && m[1]) keys.push(m[1]);
  }
  return keys;
}
