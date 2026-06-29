import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

describe("GET /api/fleet", () => {
  it("returns a federation snapshot with clusters, summary, and recent activity", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps, { id: "prod-eu", name: "Prod EU" });
    seedCluster(deps, { id: "prod-us", name: "Prod US" });
    seedRegistryService(deps, { name: "api", clusterId: "prod-eu" });
    seedRegistryService(deps, { name: "etl", clusterId: "prod-us" });

    const r = await call(buildApp(deps), "GET", "/api/fleet");
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ clusters: 2, services: 2 });
    expect(r.body.clusters.map((c: { id: string }) => c.id).sort()).toEqual(["prod-eu", "prod-us"]);
  });

  it("includes degraded service counts", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "broken" });
    // Mark service as degraded.
    deps.state.setServiceDegraded("broken", "health-gate-failed");
    const r = await call(buildApp(deps), "GET", "/api/fleet");
    expect(r.status).toBe(200);
    expect(r.body.summary.degradedServices).toBe(1);
    expect(r.body.clusters[0].services.degraded).toBe(1);
  });

  it("is callable by a viewer (read-only fleet view)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/fleet");
    expect(r.status).toBe(200);
  });
});
