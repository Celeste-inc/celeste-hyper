import { spawn } from "node:child_process";
import type { RunResult } from "./k8s.ts";

/** Thin async runner for the `helm` CLI against a cluster's kubeconfig (injected for testability). */
export interface HelmLike {
  run(clusterId: string, args: string[]): Promise<RunResult>;
}

/** Minimal view of the K8s pool the real runner needs: each cluster's resolved kubeconfig path. */
export interface KubeconfigSource {
  get(clusterId: string): { kubeconfig?: string } | null;
}

const HELM_PROCESS_TIMEOUT_MS = 210_000; // > helm's own `--timeout 180s`, bounds a hung/prompting helm
const HELM_MAX_STDOUT = 8 * 1024 * 1024; // cap buffered output (chart values can't legitimately be huge)

/** Real `helm` runner: spawns `helm` with the target cluster's KUBECONFIG (argv form, no shell). */
export class Helm implements HelmLike {
  constructor(private readonly pool: KubeconfigSource) {}

  run(clusterId: string, args: string[]): Promise<RunResult> {
    const kubeconfig = this.pool.get(clusterId)?.kubeconfig;
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (kubeconfig) env.KUBECONFIG = kubeconfig;
      const child = spawn("helm", args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      // A hung helm (network stall, credential prompt) would otherwise leave this promise pending
      // forever; kill it past the deadline so the GET/job recovers with a clear error.
      const killTimer = setTimeout(() => {
        overflow = false;
        child.kill("SIGKILL");
        resolve({ code: 124, stdout, stderr: stderr || `helm timed out after ${HELM_PROCESS_TIMEOUT_MS}ms` });
      }, HELM_PROCESS_TIMEOUT_MS);
      child.stdout.on("data", (b) => {
        if (stdout.length > HELM_MAX_STDOUT) {
          if (!overflow) (overflow = true), child.kill("SIGKILL");
          return;
        }
        stdout += b.toString();
      });
      child.stderr.on("data", (b) => (stderr += b.toString()));
      child.on("error", (e) => (clearTimeout(killTimer), reject(e)));
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (overflow) return resolve({ code: 1, stdout: "", stderr: "helm output exceeded the size limit" });
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}

export interface HelmRelease {
  name: string;
  namespace: string;
  chart: string; // e.g. "nginx-15.1.0"
  appVersion: string;
  revision: number;
  status: string;
}

const RELEASE_NAME_ANNOTATION = "meta.helm.sh/release-name";
const RELEASE_NS_ANNOTATION = "meta.helm.sh/release-namespace";

/** Parse `helm list -o json`. Returns [] on malformed input (never throws). */
export function parseHelmList(stdout: string): HelmRelease[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: HelmRelease[] = [];
  for (const r of parsed) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    out.push({
      name: o.name,
      namespace: typeof o.namespace === "string" ? o.namespace : "",
      chart: typeof o.chart === "string" ? o.chart : "",
      appVersion: typeof o.app_version === "string" ? o.app_version : "",
      revision: typeof o.revision === "string" ? Number(o.revision) : typeof o.revision === "number" ? o.revision : 0,
      status: typeof o.status === "string" ? o.status : "",
    });
  }
  return out;
}

/**
 * The Helm release a workload belongs to, from its standard annotations. Both the release-name and
 * release-namespace annotations must be present, else the workload is not Helm-managed (returns null).
 */
export function helmReleaseFromAnnotations(annotations: Record<string, unknown> | null | undefined): { name: string; namespace: string } | null {
  if (!annotations) return null;
  const name = annotations[RELEASE_NAME_ANNOTATION];
  const namespace = annotations[RELEASE_NS_ANNOTATION];
  if (typeof name !== "string" || typeof namespace !== "string" || !name || !namespace) return null;
  return { name, namespace };
}

// Redact a key at ANY depth if it names a secret. Substring (not anchored) so plurals/nesting are
// covered: "secret(s)", "token(s)", "credential(s)", "passphrase", "keystore", "jwt", "*Key(s)" via
// `keys?$`, and `api`/`access`/`private` key variants. (`credentials`/`secrets` nested blocks are
// caught here too, so there's no top-level-only special case.)
const REDACT_KEY = /password|passphrase|secret|token|credential|private|keystore|jwt|api[-_]?key|access[-_]?key|keys?$/i;
// Redact a string VALUE that carries an inline credential, regardless of its key name —
// `scheme://user:pass@host` (postgres/redis/mongo/amqp DSNs, etc.).
const CRED_URI = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const REDACTED = "***";

/**
 * Recursively redact sensitive chart values before returning them to a client: any key naming a
 * secret (see `REDACT_KEY`) at any depth, plus any string value that embeds an inline credential.
 */
export function redactValues(values: unknown): unknown {
  if (typeof values === "string") return CRED_URI.test(values) ? REDACTED : values;
  if (Array.isArray(values)) return values.map((v) => redactValues(v));
  if (typeof values !== "object" || values === null) return values;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    out[k] = REDACT_KEY.test(k) ? REDACTED : redactValues(v);
  }
  return out;
}

/**
 * Build the argv for a tag-bump upgrade: `helm upgrade <release> <chartRef> -n <ns> --reuse-values
 * --set <valuePath>=<tag> --wait --timeout 180s`. The value path is operator-configured per service
 * (`helmImageTagValuePath`) — we never guess `image.tag`.
 */
export function buildUpgradeArgs(release: string, chartRef: string, namespace: string, valuePath: string, tag: string): string[] {
  return [
    "upgrade",
    release,
    chartRef,
    "-n",
    namespace,
    "--reuse-values",
    "--set",
    `${valuePath}=${tag}`,
    "--wait",
    "--timeout",
    "180s",
  ];
}

/** argv for `helm get values <release> -n <ns> -o json` (the operator-supplied overrides only — we
 *  deliberately omit `-a/--all`, which would surface every chart default and widen the secret
 *  surface returned to viewers). */
export function getValuesArgs(release: string, namespace: string): string[] {
  return ["get", "values", release, "-n", namespace, "-o", "json"];
}

/** argv for `helm list -n <ns> -o json`. */
export function listArgs(namespace: string): string[] {
  return ["list", "-n", namespace, "-o", "json"];
}
