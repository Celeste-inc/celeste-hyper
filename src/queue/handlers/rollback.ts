import type { JobRow } from "../queue.ts";
import type { JobHandler } from "../worker.ts";
import type { State } from "../../lib/state.ts";
import type { Registry } from "../../services/registry.ts";
import type { K8sPool } from "../../services/k8s-pool.ts";
import type { ServiceModel } from "../../services/model.ts";
import { workloadNameFor, containerNameFor } from "../../services/model.ts";
import { parseRolloutHistory, previousRevision } from "../../services/rollout-history.ts";

export const ROLLBACK_JOB_KIND = "rollback";

export interface RollbackTarget {
  /** Previous image tag, if hyper's own history knows it (Source A). */
  previousTag: string | null;
  /** Previous cluster revision, if resolved from `kubectl rollout history` (Source B). */
  previousRevision: number | null;
  source: "hyper" | "cluster" | null; // null → nothing to roll back to
}

export interface RollbackDeps {
  state: State;
  registry: Registry;
  pool: K8sPool;
}

interface RollbackPayload extends RollbackTarget {
  expectedTag: string | null; // what we expect the pod template to read after undo (Source A only)
  auto?: boolean; // P1.9: this rollback was auto-enqueued by a failed health gate
}

function kindOf(svc: ServiceModel): string {
  return svc.sourceType === "registry-pull" ? svc.workloadKind : "Deployment";
}

/**
 * Resolve the rollback target for a registry-pull service. Prefers hyper's own deployment history
 * (Source A: exact previous tag); falls back to the cluster's `kubectl rollout history`
 * (Source B: a revision number, tag unknown until after the undo).
 */
export async function resolveRollbackTarget(
  deps: Pick<RollbackDeps, "state" | "pool">,
  svc: ServiceModel,
  currentTag: string,
): Promise<RollbackTarget> {
  const hyperTag = deps.state.previousDoneTag(svc.name, currentTag);
  if (hyperTag) return { previousTag: hyperTag, previousRevision: null, source: "hyper" };

  const k8s = deps.pool.get(svc.clusterId);
  if (k8s) {
    const r = await k8s
      .kubectl(["-n", svc.namespace, "rollout", "history", `${kindOf(svc)}/${workloadNameFor(svc)}`])
      .catch(() => null);
    if (r && r.code === 0) {
      const rev = previousRevision(parseRolloutHistory(r.stdout));
      if (rev !== null) return { previousTag: null, previousRevision: rev, source: "cluster" };
    }
  }
  return { previousTag: null, previousRevision: null, source: null };
}

/** Read the live pod-template image tag for a workload's container (post-rollback verification). */
async function readWorkloadImageTag(
  pool: K8sPool,
  svc: ServiceModel,
  kind: string,
  workload: string,
  container: string,
): Promise<string | null> {
  const k8s = pool.get(svc.clusterId);
  if (!k8s) return null;
  const r = await k8s
    .kubectl([
      "-n",
      svc.namespace,
      "get",
      kind.toLowerCase(),
      workload,
      "-o",
      `jsonpath={.spec.template.spec.containers[?(@.name=="${container}")].image}`,
    ])
    .catch(() => null);
  if (!r || r.code !== 0) return null;
  return imageTag(r.stdout.trim());
}

/** Extract the tag from an image ref, tolerating a registry port and digest pins. */
export function imageTag(image: string): string | null {
  if (!image) return null;
  const ref = image.split("/").pop() ?? image; // last path segment: registry:port lives earlier
  if (ref.includes("@")) return null; // digest-pinned (img@sha256:...) — no tag
  const idx = ref.lastIndexOf(":");
  return idx > 0 ? ref.slice(idx + 1) : null;
}

/**
 * Job handler for `kind='rollback'`. Runs `kubectl rollout undo` (+ optional `--to-revision`),
 * waits for the rollout, then reads the resulting image tag. The fenced `current_deployment` write
 * uses the expected tag only if the pod template confirms it; otherwise `rollback-rev-N` + a warning.
 */
export function makeRollbackHandler(deps: RollbackDeps): JobHandler {
  return async (job: JobRow): Promise<void> => {
    try {
      await runRollback(deps, job);
    } catch (e) {
      // P1.9 single-shot: if an AUTOMATIC rollback itself fails, mark the service degraded so hyper
      // takes no further automatic action (degraded services refuse new deploys until cleared).
      if ((JSON.parse(job.payload) as RollbackPayload).auto) {
        deps.state.setServiceDegraded(job.resource_id, `auto-rollback failed: ${(e as Error).message}`);
      }
      throw e;
    }
  };
}

async function runRollback(deps: RollbackDeps, job: JobRow): Promise<void> {
    const payload = JSON.parse(job.payload) as RollbackPayload;
    const svc = deps.registry.get(job.resource_id);
    if (!svc) throw new Error(`service '${job.resource_id}' not found`);
    if (svc.sourceType !== "registry-pull") throw new Error("rollback is supported for registry-pull services only");

    const kind = kindOf(svc);
    const workload = workloadNameFor(svc);
    const container = containerNameFor(svc);
    const fallbackTag = payload.expectedTag ?? `rollback-rev-${payload.previousRevision ?? "unknown"}`;
    deps.state.ensureDeploymentRow(job.id, svc.name, fallbackTag, "rollback");
    deps.state.updateDeployment(job.id, "applying");

    const k8s = deps.pool.getOrThrow(svc.clusterId);
    const undoArgs = ["-n", svc.namespace, "rollout", "undo", `${kind}/${workload}`];
    if (payload.previousRevision !== null) undoArgs.push(`--to-revision=${payload.previousRevision}`);
    const undo = await k8s.kubectl(undoArgs);
    if (undo.code !== 0) throw new Error(undo.stderr || undo.stdout);

    const rs = await k8s.rolloutStatus(kind, workload, svc.namespace, 180);
    if (rs.code !== 0) throw new Error(rs.stderr || rs.stdout);

    const resultingTag = await readWorkloadImageTag(deps.pool, svc, kind, workload, container);
    const revSuffix = payload.previousRevision !== null ? ` (revision ${payload.previousRevision})` : "";

    let finalTag: string;
    let message: string;
    if (payload.expectedTag) {
      if (resultingTag === payload.expectedTag) {
        finalTag = payload.expectedTag;
        message = `rollback to ${payload.expectedTag}${revSuffix}`;
      } else {
        // Expected from hyper history but the rollout landed elsewhere: record the truth — the
        // cluster revision if we know it, else the image actually running (never a fake tag).
        finalTag =
          payload.previousRevision !== null
            ? `rollback-rev-${payload.previousRevision}`
            : resultingTag ?? "rollback-rev-unknown";
        message = `rollback applied; pod image '${resultingTag ?? "unknown"}' != expected '${payload.expectedTag}'`;
      }
    } else {
      finalTag = resultingTag ?? `rollback-rev-${payload.previousRevision ?? "unknown"}`;
      message = `rollback to ${finalTag}${revSuffix}`;
    }

    // Atomic finalize: fenced current-tag write + terminal status + clear degraded in one tx, so a
    // crash can't leave the service degraded once the deployment already reads `done` (auto or manual).
    deps.state.finalizeRollback(svc.name, finalTag, job.fencing_token, job.id, message);
}
