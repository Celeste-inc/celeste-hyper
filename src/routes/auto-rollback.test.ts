import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";
import { ROLLBACK_JOB_KIND } from "../queue/handlers/rollback.ts";

function enqueuePending(deps: ReturnType<typeof makeFakeDeps>, service = "hello") {
  const id = deps.state.recordDeploymentStart(service, "v1", "rollback");
  deps.queue.enqueue({
    id,
    kind: ROLLBACK_JOB_KIND,
    resourceKind: "service",
    resourceId: service,
    payload: { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1", auto: true },
    delayMs: 10_000,
  });
  return id;
}

describe("auto-rollback / degraded routes", () => {
  it("POST deploy on a degraded service → 409 service-degraded", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    deps.state.setServiceDegraded("hello", "auto-rollback failed: kubectl boom");
    const r = await call(buildApp(deps), "POST", "/api/services/hello/deploy", { tag: "v5" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("service-degraded");
    expect(r.body.reason).toContain("boom");
  });

  it("POST undegrade clears the mark and re-enables deploys", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    deps.state.setServiceDegraded("hello", "x");
    const app = buildApp(deps);

    const u = await call(app, "POST", "/api/services/hello/undegrade");
    expect(u.status).toBe(200);
    expect(u.body.cleared).toBe(true);
    expect(deps.state.serviceDegraded("hello")).toBeNull();

    const r = await call(app, "POST", "/api/services/hello/deploy", { tag: "v5" });
    expect(r.status).toBe(202);
  });

  it("POST undegrade on a healthy service is a no-op → cleared:false", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/hello/undegrade");
    expect(r.status).toBe(200);
    expect(r.body.cleared).toBe(false);
  });

  it("GET auto-rollback reports the pending grace job + degraded state", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const id = enqueuePending(deps);
    deps.state.setServiceDegraded("hello", "prior failure");
    const r = await call(buildApp(deps), "GET", "/api/services/hello/auto-rollback");
    expect(r.status).toBe(200);
    expect(r.body.pending.id).toBe(id);
    expect(r.body.pending.nextAttemptAt).toBeTruthy();
    expect(r.body.degraded.reason).toBe("prior failure");
  });

  it("GET auto-rollback on a clean service → nulls", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/auto-rollback");
    expect(r.status).toBe(200);
    expect(r.body.pending).toBeNull();
    expect(r.body.degraded).toBeNull();
  });

  it("POST auto-rollback/cancel cancels a pending grace rollback and marks it cancelled", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const id = enqueuePending(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/hello/auto-rollback/cancel");
    expect(r.status).toBe(200);
    expect(r.body.cancelled).toBe(true);
    expect(r.body.jobId).toBe(id);
    expect(deps.queue.pendingJob("hello", ROLLBACK_JOB_KIND)).toBeNull();
    expect(deps.state.deploymentById(id)!.status).toBe("cancelled");
  });

  it("does not report or cancel a MANUAL rollback via the auto-rollback endpoints (auto-only filter)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    // a manual rollback (no auto flag) sits pending for the service
    const manual = deps.state.recordDeploymentStart("hello", "v1", "rollback");
    deps.queue.enqueue({ id: manual, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1" }, delayMs: 10_000 });
    const app = buildApp(deps);

    const status = await call(app, "GET", "/api/services/hello/auto-rollback");
    expect(status.body.pending).toBeNull(); // the manual rollback is invisible to the auto endpoint

    const cancel = await call(app, "POST", "/api/services/hello/auto-rollback/cancel");
    expect(cancel.status).toBe(404); // nothing AUTO to cancel
    expect(deps.queue.getJob(manual)!.state).toBe("pending"); // manual rollback untouched
  });

  it("POST auto-rollback/cancel with nothing pending → 404", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/hello/auto-rollback/cancel");
    expect(r.status).toBe(404);
  });

  it("POST auto-rollback/cancel is a 404 once the worker has claimed the rollback", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    // enqueue with no grace so it is immediately claimable, then let the worker claim it
    const id = deps.state.recordDeploymentStart("hello", "v1", "rollback");
    deps.queue.enqueue({ id, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { auto: true } });
    expect(deps.queue.claim("w1")).not.toBeNull(); // now 'running', no longer pending
    const r = await call(buildApp(deps), "POST", "/api/services/hello/auto-rollback/cancel");
    expect(r.status).toBe(404); // pendingJob() only matches state='pending'
  });

  it("all four endpoints 404 on an unknown service", async () => {
    const app = buildApp(makeFakeDeps());
    expect((await call(app, "GET", "/api/services/ghost/auto-rollback")).status).toBe(404);
    expect((await call(app, "POST", "/api/services/ghost/auto-rollback/cancel")).status).toBe(404);
    expect((await call(app, "POST", "/api/services/ghost/undegrade")).status).toBe(404);
  });
});
