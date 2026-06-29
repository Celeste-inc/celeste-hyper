import { Elysia, sse } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import { DEPLOY_JOB_KIND } from "../queue/handlers/deploy.ts";
import { ROLLBACK_JOB_KIND, resolveRollbackTarget } from "../queue/handlers/rollback.ts";
import { preflightSetImage } from "../services/preflight.ts";
import { deployEvents } from "./deploy-stream.ts";

const DeployBody = z.object({ tag: z.string().min(1) });
const R2_ROLLBACK_ERROR = "r2-bundle-uses-deploy-history";

export const deploymentRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/services/:name/deployments",
      ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        return { items: deps.state.recentDeployments(svc.name) };
      },
      { detail: { summary: "Recent deployments for a service", tags: ["deployments"] } },
    )
    .post(
      "/services/:name/deploy",
      ({ params, body, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const degraded = deps.state.serviceDegraded(svc.name);
        if (degraded) return status(409, { error: "service-degraded", reason: degraded.reason, at: degraded.at });
        const parsed = DeployBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const tag = parsed.data.tag;
        // The deployment row is the id source; the job adopts that id (1:1 invariant) so the
        // legacy `/deployments/:id` is populated immediately (no 404 window) and the worker runs
        // the deploy under the per-service lock + fencing token.
        const deploymentId = deps.state.recordDeploymentStart(svc.name, tag);
        deps.queue.enqueue({
          id: deploymentId,
          kind: DEPLOY_JOB_KIND,
          resourceKind: "service",
          resourceId: svc.name,
          payload: { tag },
        });
        return status(202, { deploymentId, accepted: true });
      },
      { detail: { summary: "Deploy a tag (enqueues a background job)", tags: ["deployments"] } },
    )
    .get(
      "/services/:name/preflight",
      async ({ params, query, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const tag = query.tag;
        if (!tag) return status(400, { error: "tag query parameter required" });
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });
        // Advisory admission dry-run (P3.3) — surfaces webhook/policy denials before the real deploy.
        return await preflightSetImage(k8s, svc, tag);
      },
      { detail: { summary: "Server-side admission dry-run for a tag (registry-pull)", tags: ["deployments"] } },
    )
    .get(
      "/services/:name/rollback",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        if (svc.sourceType !== "registry-pull") {
          return { eligible: false, reason: R2_ROLLBACK_ERROR, previousTag: null, previousRevision: null, source: null };
        }
        const currentTag = deps.state.getCurrent(svc.name)?.tag ?? "";
        const target = await resolveRollbackTarget(deps, svc, currentTag);
        return { eligible: target.source !== null, ...target };
      },
      { detail: { summary: "Preview the rollback target (previous tag/revision) for a service", tags: ["deployments"] } },
    )
    .post(
      "/services/:name/rollback",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        if (svc.sourceType !== "registry-pull") return status(409, { error: R2_ROLLBACK_ERROR });
        const currentTag = deps.state.getCurrent(svc.name)?.tag ?? "";
        const target = await resolveRollbackTarget(deps, svc, currentTag);
        if (target.source === null) return status(404, { error: "no previous version to roll back to" });
        const tag = target.previousTag ?? `rollback-rev-${target.previousRevision}`;
        // Same 1:1 id pattern as deploy: deployment row (action=rollback) is the id source.
        const jobId = deps.state.recordDeploymentStart(svc.name, tag, "rollback");
        deps.queue.enqueue({
          id: jobId,
          kind: ROLLBACK_JOB_KIND,
          resourceKind: "service",
          resourceId: svc.name,
          payload: { ...target, expectedTag: target.previousTag },
        });
        return status(202, { jobId, accepted: true });
      },
      { detail: { summary: "Roll back a registry-pull service to its previous tag (enqueues a job)", tags: ["deployments"] } },
    )
    .get(
      "/services/:name/auto-rollback",
      ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const pending = deps.queue.pendingJob(svc.name, ROLLBACK_JOB_KIND, true);
        const degraded = deps.state.serviceDegraded(svc.name);
        return {
          pending: pending ? { id: pending.id, nextAttemptAt: pending.next_attempt_at } : null,
          degraded: degraded ?? null,
        };
      },
      { detail: { summary: "Pending auto-rollback (grace window) + degraded state for a service", tags: ["deployments"] } },
    )
    .post(
      "/services/:name/auto-rollback/cancel",
      ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const pending = deps.queue.pendingJob(svc.name, ROLLBACK_JOB_KIND, true);
        if (!pending) return status(404, { error: "no pending auto-rollback" });
        // cancelPending is atomic on state='pending'; a false return means the worker already claimed it.
        if (!deps.queue.cancelPending(pending.id)) return status(409, { error: "rollback-already-running" });
        deps.state.updateDeployment(pending.id, "cancelled", "auto-rollback cancelled by operator");
        return { cancelled: true, jobId: pending.id };
      },
      { detail: { summary: "Cancel a pending (grace-window) auto-rollback for a service", tags: ["deployments"] } },
    )
    .post(
      "/services/:name/undegrade",
      ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const was = deps.state.serviceDegraded(svc.name) !== null;
        deps.state.clearServiceDegraded(svc.name);
        return { cleared: was };
      },
      { detail: { summary: "Clear a service's degraded mark so deploys are allowed again", tags: ["deployments"] } },
    )
    .get(
      "/deployments/:id",
      ({ params, status }) => {
        const id = Number(params.id);
        if (!Number.isFinite(id)) return status(400, { error: "invalid id" });
        const row = deps.state.deploymentById(id);
        if (!row) return status(404, { error: "not found" });
        return { deployment: row };
      },
      { detail: { summary: "Get a deployment by id", tags: ["deployments"] } },
    )
    .get(
      "/deployments/:id/stream",
      async function* ({ params, status, request }) {
        const id = Number(params.id);
        if (!Number.isFinite(id)) {
          return status(400, { error: "invalid id" });
        }
        for await (const ev of deployEvents(deps.state, id, deps.clock, request.signal)) {
          yield sse({ event: ev.event, data: ev.data });
        }
      },
      { detail: { summary: "Live SSE stream of a deployment's progress", tags: ["deployments"] } },
    )
    .get(
      "/jobs/:id",
      ({ params, status }) => {
        const id = Number(params.id);
        if (!Number.isFinite(id)) return status(400, { error: "invalid id" });
        const job = deps.queue.getJob(id);
        if (!job) return status(404, { error: "not found" });
        return {
          job: {
            id: job.id,
            kind: job.kind,
            resourceKind: job.resource_kind,
            resourceId: job.resource_id,
            state: job.state,
            attempts: job.attempts,
            maxAttempts: job.max_attempts,
            nextAttemptAt: job.next_attempt_at,
            leaseUntil: job.lease_until,
            leaseHolder: job.lease_holder,
            lastError: job.last_error,
            fencingToken: job.fencing_token,
            createdAt: job.created_at,
            updatedAt: job.updated_at,
          },
        };
      },
      { detail: { summary: "Get a background job by id (richer than /deployments/:id)", tags: ["deployments"] } },
    );
