import type { JobRow } from "../queue.ts";
import type { JobHandler } from "../worker.ts";
import type { Queue } from "../queue.ts";
import type { State } from "../../lib/state.ts";
import type { Registry } from "../../services/registry.ts";
import type { Deployer } from "../../services/deploy.ts";
import type { K8sPool } from "../../services/k8s-pool.ts";
import { ROLLBACK_JOB_KIND, resolveRollbackTarget } from "./rollback.ts";
import { log } from "../../lib/logger.ts";

export interface DeployHandlerDeps {
  state: State;
  registry: Registry;
  deployer: Deployer;
  // Optional — only needed for P1.9 auto-rollback on a failed health gate.
  queue?: Queue;
  pool?: K8sPool;
}

interface DeployPayload {
  tag: string;
}

export const DEPLOY_JOB_KIND = "deploy";
export const AUTO_ROLLBACK_GRACE_MS = 10_000;

/**
 * Job handler for `kind='deploy'`. The enqueuer (HTTP route / poller) creates the `deployments`
 * row with id == job.id first, so `ensureDeploymentRow` here is an idempotent safety net (and the
 * row's creator when the handler runs in isolation). Runs the deploy under the job's fencing token
 * and throws on failure so the worker records the kubectl error in `last_error`. On a failed health
 * gate with `autoRollback`, it first enqueues a (grace-delayed) rollback job (P1.9).
 */
export function makeDeployHandler(deps: DeployHandlerDeps): JobHandler {
  return async (job: JobRow): Promise<void> => {
    const { tag } = JSON.parse(job.payload) as DeployPayload;
    const svc = deps.registry.get(job.resource_id);
    if (!svc) throw new Error(`service '${job.resource_id}' not found`);
    deps.state.ensureDeploymentRow(job.id, svc.name, tag);
    // Degraded gate at the chokepoint, not just the HTTP route: a degraded service refuses ALL
    // deploys — poller, future webhook (P1.10), or a deploy queued before its auto-rollback failed —
    // until an operator clears it via /undegrade. Terminal (no retry); the state needs a human.
    if (deps.state.serviceDegraded(svc.name)) {
      deps.queue?.noRetry(job.id);
      deps.state.updateDeployment(job.id, "failed", "service degraded; deploy blocked");
      log.warn("deploy-blocked-degraded", { service: svc.name, tag });
      throw new Error("service-degraded");
    }
    const result = await deps.deployer.deployExisting({ service: svc, tag }, job.id, job.fencing_token);
    if (result.ok) return;

    const failedStep = result.steps.find((s) => !s.ok);
    const gateFailed = result.steps.some((s) => !s.ok && s.name.includes("health-gate"));
    if (gateFailed && svc.sourceType === "registry-pull" && svc.autoRollback && deps.queue && deps.pool) {
      log.warn("deploy-failed-gate", { service: svc.name, tag, reason: failedStep?.message });
      // Dedup: never stack a second auto-rollback while one is already queued/running for this service
      // (e.g. a re-deploy during the grace window). One bad deploy → at most one rollback.
      if (deps.queue.hasActiveJob(svc.name, ROLLBACK_JOB_KIND)) {
        // A rollback is already reverting this service; retrying the bad image only churns the
        // cluster and could race that rollback for the fencing token. Terminal.
        deps.queue.noRetry(job.id);
        log.info("auto-rollback-skipped", { service: svc.name, reason: "rollback already active" });
        throw new Error(failedStep?.message ?? "deploy failed");
      }
      const currentTag = deps.state.getCurrent(svc.name)?.tag ?? "";
      const target = await resolveRollbackTarget({ state: deps.state, pool: deps.pool }, svc, currentTag);
      if (target.source !== null) {
        const rbTag = target.previousTag ?? `rollback-rev-${target.previousRevision}`;
        const rbId = deps.state.recordDeploymentStart(svc.name, rbTag, "rollback");
        deps.queue.enqueue({
          id: rbId,
          kind: ROLLBACK_JOB_KIND,
          resourceKind: "service",
          resourceId: svc.name,
          payload: { ...target, expectedTag: target.previousTag, auto: true },
          delayMs: AUTO_ROLLBACK_GRACE_MS,
        });
        // Do not retry this deploy: the image is bad, so a retry would just re-apply it and race the
        // rollback for the fencing token. Make this attempt terminal.
        deps.queue.noRetry(job.id);
        log.info("auto-rollback-enqueued", { service: svc.name, rollbackId: rbId, graceMs: AUTO_ROLLBACK_GRACE_MS });
      } else {
        log.warn("auto-rollback-skipped", { service: svc.name, reason: "no previous version" });
      }
    }
    throw new Error(failedStep?.message ?? "deploy failed");
  };
}
