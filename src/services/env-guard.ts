import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { K8sLike } from "../lib/k8s-port.ts";

export type EnvKind = "config" | "secret";
export type EnvGuardMode = "off" | "warn" | "block";
export type EnvValues = Record<string, string>;
export type EnvDigests = Record<string, string>;

export interface DriftReport {
  blocked: string[];
  warnings: string[];
}

export type LiveEnvResult = { ok: true; values: EnvValues | null } | { ok: false; message: string };

const DIGEST_KEY_FILE = "env-digest.key";

export function crossKindDuplicates(config: EnvValues, secret: EnvValues): string[] {
  return Object.keys(config).filter((key) => Object.hasOwn(secret, key)).sort();
}

export function loadDigestKey(stateDir: string): Buffer {
  const file = join(stateDir, DIGEST_KEY_FILE);
  try {
    return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(stateDir, { recursive: true });
  const key = randomBytes(32);
  try {
    writeFileSync(file, key.toString("hex"), { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  }
}

export function digestValues(key: Buffer, service: string, kind: EnvKind, values: EnvValues): EnvDigests {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      createHmac("sha256", key).update(`${service}\u0000${kind}\u0000${name}\u0000${value}`).digest("hex"),
    ]),
  );
}

export async function readLiveEnv(k8s: K8sLike, kind: EnvKind, resource: string, namespace: string): Promise<LiveEnvResult> {
  const r = await k8s.kubectl(["-n", namespace, "get", kind === "config" ? "configmap" : "secret", resource, "-o", "json"]);
  if (r.code !== 0) {
    const detail = `${r.stderr}\n${r.stdout}`;
    if (/NotFound|not found/i.test(detail)) return { ok: true, values: null };
    return { ok: false, message: detail.trim().slice(0, 200) };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.stdout) as { data?: Record<string, unknown> };
    data = parsed.data ?? {};
  } catch {
    return { ok: false, message: `${kind} read returned non-JSON` };
  }
  const values: EnvValues = {};
  for (const [name, raw] of Object.entries(data)) {
    if (typeof raw !== "string") continue;
    values[name] = kind === "secret" ? Buffer.from(raw, "base64").toString("utf8") : raw;
  }
  return { ok: true, values };
}

export function evaluateDrift(rendered: EnvDigests, live: EnvDigests | null, baseline: EnvDigests | null): DriftReport {
  const report: DriftReport = { blocked: [], warnings: [] };
  if (!live) return report;
  if (!baseline) {
    const differing = Object.keys(rendered).filter((key) => live[key] !== undefined && live[key] !== rendered[key]).sort();
    if (differing.length) report.warnings.push(`no applied baseline; values differ from the cluster: ${differing.join(", ")}`);
    return report;
  }
  const keys = [...new Set([...Object.keys(rendered), ...Object.keys(live), ...Object.keys(baseline)])].sort();
  const liveOnly: string[] = [];
  for (const key of keys) {
    const applied = baseline[key];
    const current = live[key];
    const next = rendered[key];
    if (applied === undefined) {
      if (current !== undefined && next === undefined) liveOnly.push(key);
      continue;
    }
    if (current === applied) continue;
    if (next === applied) report.blocked.push(key);
  }
  if (liveOnly.length) report.warnings.push(`keys present only in the cluster: ${liveOnly.join(", ")}`);
  return report;
}
