import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  seedRegistryService(deps);
  return deps;
}

describe("GET /api/services/:name/slo", () => {
  it("returns deploy success rate from recorded deployments", async () => {
    const deps = setup();
    // Two successful, one failed.
    const done1 = deps.state.recordDeploymentStart("hello", "v1");
    deps.state.updateDeployment(done1, "done");
    const done2 = deps.state.recordDeploymentStart("hello", "v2");
    deps.state.updateDeployment(done2, "done");
    const fail1 = deps.state.recordDeploymentStart("hello", "v3");
    deps.state.updateDeployment(fail1, "failed", "image pull");

    const r = await call(buildApp(deps), "GET", "/api/services/hello/slo");
    expect(r.status).toBe(200);
    expect(r.body.deploy.totalAttempts).toBe(3);
    expect(r.body.deploy.successful).toBe(2);
    expect(r.body.deploy.successRate).toBeCloseTo(2 / 3, 3);
  });

  it("reports degraded health when the service is currently marked degraded", async () => {
    const deps = setup();
    deps.state.setServiceDegraded("hello", "health-gate-failed");
    const r = await call(buildApp(deps), "GET", "/api/services/hello/slo");
    expect(r.status).toBe(200);
    expect(r.body.health).toBe("degraded");
    expect(r.body.incidents.ongoing).toBe(1);
  });

  it("aggregates pod restart counts from the live cluster", async () => {
    const deps = setup({
      k8s: {
        getWorkloadSelector: async () => "app=hello",
        listPods: async () => [
          { name: "p1", containers: [{ name: "c", restartCount: 0 }] },
          { name: "p2", containers: [{ name: "c", restartCount: 3 }, { name: "s", restartCount: 1 }] },
        ],
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/slo");
    expect(r.status).toBe(200);
    expect(r.body.runtime.podCount).toBe(2);
    expect(r.body.runtime.totalRestarts).toBe(4);
  });

  it("returns 404 for an unknown service", async () => {
    const deps = setup();
    const r = await call(buildApp(deps), "GET", "/api/services/ghost/slo");
    expect(r.status).toBe(404);
  });

  it("returns healthy for a fresh service with no deploys, no incidents, no restarts", async () => {
    const deps = setup({
      k8s: {
        getWorkloadSelector: async () => "app=hello",
        listPods: async () => [],
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/slo");
    expect(r.status).toBe(200);
    expect(r.body.health).toBe("healthy");
    expect(r.body.deploy.successRate).toBeNull();
  });
});
