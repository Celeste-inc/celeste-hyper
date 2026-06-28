import type { JobRow } from "../queue.ts";
import type { JobHandler } from "../worker.ts";
import type { State } from "../../lib/state.ts";
import type { Registry } from "../../services/registry.ts";
import type { K8sPool } from "../../services/k8s-pool.ts";
import type { HelmLike } from "../../lib/helm.ts";
import { buildUpgradeArgs, helmReleaseFromAnnotations } from "../../lib/helm.ts";
import { imageTag } from "./rollback.ts";
import { workloadKindFor, workloadNameFor, containerNameFor } from "../../services/model.ts";
import { log } from "../../lib/logger.ts";

export const HELM_UPGRADE_JOB_KIND = "helm-upgrade";

export interface HelmUpgradeDeps {
  state: State;
  registry: Registry;
  helm: HelmLike;
  pool: K8sPool;
}

interface HelmPayload {
  tag: string;
}

/**
 * Job handler for `kind='helm-upgrade'` (P2.2). Runs `helm upgrade … --set <valuePath>=<tag> --wait`
 * under the per-service lock, then **verifies** the new tag actually reached the workload's pod
 * template — a wrong `helmImageTagValuePath` would otherwise silently no-op. On mismatch the job fails
 * with `helm-upgrade-did-not-take-effect` so the operator knows the configured values path is wrong.
 */
export function makeHelmUpgradeHandler(deps: HelmUpgradeDeps): JobHandler {
  return async (job: JobRow): Promise<void> => {
    const { tag } = JSON.parse(job.payload) as HelmPayload;
    const svc = deps.registry.get(job.resource_id);
    if (!svc) throw new Error(`service '${job.resource_id}' not found`);
    if (!svc.helmRelease || !svc.helmChartRef || !svc.helmImageTagValuePath) {
      throw new Error("service is not configured for helm upgrade");
    }
    deps.state.ensureDeploymentRow(job.id, svc.name, tag);
    deps.state.updateDeployment(job.id, "applying");

    const k8s = deps.pool.getOrThrow(svc.clusterId);
    const kind = workloadKindFor(svc);
    const workload = workloadNameFor(svc);
    const container = containerNameFor(svc);

    // The release namespace is authoritative from the workload's helm annotation; fall back to the
    // service namespace if the workload can't be read or isn't annotated.
    let releaseNs = svc.namespace;
    const wj = await k8s.getWorkloadJson(kind, workload, svc.namespace).catch(() => null);
    if (wj && wj.code === 0) {
      try {
        const ann = (JSON.parse(wj.stdout) as { metadata?: { annotations?: Record<string, unknown> } }).metadata?.annotations;
        releaseNs = helmReleaseFromAnnotations(ann)?.namespace ?? svc.namespace;
      } catch {
        // keep the fallback
      }
    }

    const up = await deps.helm.run(svc.clusterId, buildUpgradeArgs(svc.helmRelease, svc.helmChartRef, releaseNs, svc.helmImageTagValuePath, tag));
    if (up.code !== 0) throw new Error(up.stderr || up.stdout || "helm upgrade failed");

    // Verify the tag took effect (catches a misconfigured values path that silently does nothing).
    const r = await k8s
      .kubectl(["-n", svc.namespace, "get", kind.toLowerCase(), workload, "-o", `jsonpath={.spec.template.spec.containers[?(@.name=="${container}")].image}`])
      .catch(() => null);
    const got = r && r.code === 0 ? imageTag(r.stdout.trim()) : null;
    if (got !== tag) throw new Error("helm-upgrade-did-not-take-effect");

    deps.state.setCurrentFenced(svc.name, tag, job.fencing_token);
    deps.state.updateDeployment(job.id, "done", `helm upgrade to ${tag}`);
    log.info("helm-upgrade.done", { service: svc.name, tag, release: svc.helmRelease });
  };
}
