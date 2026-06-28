import type { K8sLike } from "../lib/k8s-port.ts";
import type { ServiceModel } from "./model.ts";
import { workloadNameFor, workloadKindFor, containerNameFor } from "./model.ts";

export interface PreflightResult {
  applicable: boolean; // false → this source type can't be cheaply dry-run'd (r2-bundle/git-sync)
  ok?: boolean; // did the server-side admission dry-run pass
  reason?: string; // the denial/validation error when !ok
}

const NAME_RE = /^[a-z0-9][a-z0-9.-]*$/; // RFC-1123-ish, matches the model's id rule
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Admission preflight (P3.3): a server-side dry run of a registry-pull image bump so admission
 * webhooks / validating policies (Kyverno, OPA, PodSecurity, image policies) and apiserver
 * validation reject *before* the operator confirms — not into a failed job later. `--dry-run=server`
 * runs mutating+validating admission with `dryRun=All` (no persistence). r2-bundle/git-sync need the
 * materialized manifests to dry-run, so they report `applicable:false` rather than guessing.
 */
export async function preflightSetImage(k8s: K8sLike, svc: ServiceModel, tag: string): Promise<PreflightResult> {
  if (svc.sourceType !== "registry-pull") return { applicable: false };
  if (!TAG_RE.test(tag)) return { applicable: true, ok: false, reason: "invalid tag" };
  const kind = workloadKindFor(svc);
  const workload = workloadNameFor(svc);
  const container = containerNameFor(svc);
  if (!NAME_RE.test(workload) || !NAME_RE.test(container)) return { applicable: true, ok: false, reason: "invalid workload/container name" };

  let r;
  try {
    r = await k8s.kubectl([
      "-n", svc.namespace,
      "set", "image",
      "--dry-run=server",
      "--request-timeout=10s",
      "--", // end of options: the workload/container=image positionals can never be read as flags
      `${kind.toLowerCase()}/${workload}`,
      `${container}=${svc.imageRef}:${tag}`,
    ]);
  } catch (e) {
    return { applicable: true, ok: false, reason: `preflight unavailable: ${(e as Error).message}` };
  }
  if (r.code === 0) return { applicable: true, ok: true };
  return { applicable: true, ok: false, reason: (r.stderr || r.stdout).trim().slice(0, 2000) };
}
