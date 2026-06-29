import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import { parseHelmList, helmReleaseFromAnnotations, redactValues, getValuesArgs, listArgs } from "../lib/helm.ts";
import { HELM_UPGRADE_JOB_KIND } from "../queue/handlers/helm-upgrade.ts";
import { workloadKindFor, workloadNameFor } from "../services/model.ts";

// The tag is interpolated into `--set <path>=<tag>`; helm comma-splits --set values, so constrain it
// to a safe image-tag charset (no leading `-`, no `,`/`=`/whitespace) to prevent argument injection.
const UpgradeBody = z.object({ tag: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "invalid image tag") });

/** `helmCli` is a host capability probed once at boot; re-probe if currently false so a helm install
 *  done after Hyper started gets picked up without restarting the binary. */
function helmCapable(deps: ApiDeps, clusterId: string): boolean {
  const cached = Boolean(deps.capabilities.merged(clusterId).capabilities.helmCli?.value);
  if (cached) return true;
  deps.capabilities.refreshHost();
  return Boolean(deps.capabilities.merged(clusterId).capabilities.helmCli?.value);
}

export const helmRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/services/:name/helm",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        if (!helmCapable(deps, svc.clusterId)) return status(409, { error: "helmCli capability not available" });
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });

        const wj = await k8s.getWorkloadJson(workloadKindFor(svc), workloadNameFor(svc), svc.namespace);
        if (wj.code !== 0) return { helm: null }; // workload not found
        let release: { name: string; namespace: string } | null = null;
        try {
          const ann = (JSON.parse(wj.stdout) as { metadata?: { annotations?: Record<string, unknown> } }).metadata?.annotations;
          release = helmReleaseFromAnnotations(ann);
        } catch {
          release = null;
        }
        if (!release) return { helm: null }; // not Helm-managed → the UI hides the affordance

        const listed = parseHelmList((await deps.helm.run(svc.clusterId, listArgs(release.namespace))).stdout);
        const found = listed.find((r) => r.name === release!.name) ?? null;
        const valsRes = await deps.helm.run(svc.clusterId, getValuesArgs(release.name, release.namespace));
        let valuesRedacted: unknown = null;
        if (valsRes.code === 0) {
          try {
            valuesRedacted = redactValues(JSON.parse(valsRes.stdout));
          } catch {
            valuesRedacted = null;
          }
        }
        return {
          helm: {
            release: release.name,
            namespace: release.namespace,
            chart: found?.chart ?? null,
            version: found?.appVersion ?? null,
            upgradeable: Boolean(svc.helmRelease && svc.helmChartRef && svc.helmImageTagValuePath),
            valuesRedacted,
          },
        };
      },
      { detail: { summary: "Helm release info for a service's workload (capability-gated)", tags: ["helm"] } },
    )
    .post(
      "/services/:name/helm/upgrade",
      ({ params, body, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        if (!helmCapable(deps, svc.clusterId)) return status(409, { error: "helmCli capability not available" });
        if (!svc.helmRelease || !svc.helmChartRef || !svc.helmImageTagValuePath) {
          return status(422, { error: "helm-not-configured", reason: "helmRelease, helmChartRef and helmImageTagValuePath are required" });
        }
        const parsed = UpgradeBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const tag = parsed.data.tag;
        // 1:1 id (deployment row == job id), same as deploy; runs under the per-service lock + fencing.
        const id = deps.state.recordDeploymentStart(svc.name, tag);
        deps.queue.enqueue({ id, kind: HELM_UPGRADE_JOB_KIND, resourceKind: "service", resourceId: svc.name, payload: { tag } });
        return status(202, { deploymentId: id, accepted: true });
      },
      { detail: { summary: "Bump the image tag via `helm upgrade` (enqueues a job)", tags: ["helm"] } },
    );
