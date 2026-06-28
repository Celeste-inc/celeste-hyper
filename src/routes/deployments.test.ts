import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

describe("deployment routes", () => {
  it("POST /api/services/:name/deploy → 202 with { deploymentId, accepted: true }", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/hello/deploy", { tag: "v1.10.4" });
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(true);
    expect(typeof r.body.deploymentId).toBe("number");
  });

  it("POST /api/services/:name/deploy unknown service → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/services/ghost/deploy", { tag: "v1" });
    expect(r.status).toBe(404);
  });

  it("POST /api/services/:name/deploy invalid body → 422", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/hello/deploy", {});
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("invalid body");
  });

  it("GET /api/deployments/:id known → 200 with { deployment }", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    const created = await call(app, "POST", "/api/services/hello/deploy", { tag: "v1.10.4" });
    const id = created.body.deploymentId;
    const r = await call(app, "GET", `/api/deployments/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.deployment.id).toBe(id);
    expect(r.body.deployment.service).toBe("hello");
    expect(r.body.deployment.tag).toBe("v1.10.4");
  });

  it("GET /api/deployments/:id unknown → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/api/deployments/9999");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not found");
  });

  it("GET /api/services/:name/deployments unknown service → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/api/services/ghost/deployments");
    expect(r.status).toBe(404);
  });

  it("POST /deploy enqueues a job whose id == the deploymentId (1:1 invariant)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    const created = await call(app, "POST", "/api/services/hello/deploy", { tag: "v2" });
    const id = created.body.deploymentId as number;
    const job = deps.queue.getJob(id);
    expect(job).not.toBeNull();
    expect(job!.kind).toBe("deploy");
    expect(job!.resource_id).toBe("hello");
    expect(job!.state).toBe("pending");
    expect(JSON.parse(job!.payload).tag).toBe("v2");
  });

  it("GET /api/jobs/:id returns the richer job body", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    const created = await call(app, "POST", "/api/services/hello/deploy", { tag: "v3" });
    const id = created.body.deploymentId as number;
    const r = await call(app, "GET", `/api/jobs/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.job.id).toBe(id);
    expect(r.body.job.kind).toBe("deploy");
    expect(r.body.job.state).toBe("pending");
    expect(r.body.job.attempts).toBe(0);
    expect(r.body.job.maxAttempts).toBeGreaterThan(0);
  });

  it("GET /api/jobs/:id unknown → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/api/jobs/9999");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not found");
  });
});
