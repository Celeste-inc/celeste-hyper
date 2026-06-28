import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService, seedR2Service } from "./test-helpers.ts";

function withHistory(deps: ReturnType<typeof makeFakeDeps>, service = "hello") {
  // Seed hyper history: v1 then v2 done, current = v2 → previous = v1 (Source A).
  deps.state.updateDeployment(deps.state.recordDeploymentStart(service, "v1"), "done");
  deps.state.updateDeployment(deps.state.recordDeploymentStart(service, "v2"), "done");
  deps.state.setCurrent(service, "v2");
}

describe("rollback routes", () => {
  it("GET /api/services/:name/rollback previews the previous tag (Source A)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    withHistory(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/rollback");
    expect(r.status).toBe(200);
    expect(r.body.eligible).toBe(true);
    expect(r.body.previousTag).toBe("v1");
    expect(r.body.source).toBe("hyper");
  });

  it("POST /api/services/:name/rollback enqueues a rollback job → 202 { jobId }", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    withHistory(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/hello/rollback");
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(true);
    const jobId = r.body.jobId as number;
    const job = deps.queue.getJob(jobId)!;
    expect(job.kind).toBe("rollback");
    expect(deps.state.deploymentById(jobId)!.action).toBe("rollback");
    expect(deps.state.deploymentById(jobId)!.tag).toBe("v1");
  });

  it("POST rollback on an r2-bundle service → 409 r2-bundle-uses-deploy-history", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedR2Service(deps); // "pay"
    const r = await call(buildApp(deps), "POST", "/api/services/pay/rollback");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("r2-bundle-uses-deploy-history");
  });

  it("GET rollback on an r2-bundle service is ineligible (uses deploy history)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedR2Service(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/pay/rollback");
    expect(r.status).toBe(200);
    expect(r.body.eligible).toBe(false);
    expect(r.body.reason).toBe("r2-bundle-uses-deploy-history");
  });

  it("POST rollback with no previous version → 404", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps); // no deployments; fake kubectl history has no revisions
    const r = await call(buildApp(deps), "POST", "/api/services/hello/rollback");
    expect(r.status).toBe(404);
  });

  it("POST rollback unknown service → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/services/ghost/rollback");
    expect(r.status).toBe(404);
  });
});
