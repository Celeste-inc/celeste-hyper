import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, TEST_JWT_SECRET, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";
import { signJwt } from "../lib/jwt.ts";

const helloHpa = {
  metadata: { name: "hello", namespace: "default" },
  spec: {
    scaleTargetRef: { kind: "Deployment", name: "hello" },
    minReplicas: 2,
    maxReplicas: 10,
    metrics: [
      { type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 70 } } },
      { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 50 } } },
    ],
  },
  status: { currentReplicas: 3, desiredReplicas: 4 },
};

async function setup(over: FakeDepsOptions = {}, refresh = true) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  seedRegistryService(deps); // "hello", Deployment
  if (refresh) await deps.capabilities.refreshCluster("primary"); // fake api-versions has autoscaling/v2 → hpaV2
  return deps;
}

describe("HPA routes", () => {
  it("GET returns null when no HPA targets the workload", async () => {
    const deps = await setup({ k8s: { listHpas: async () => [] } });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/hpa");
    expect(r.status).toBe(200);
    expect(r.body.hpa).toBeNull();
  });

  it("GET returns the HPA summary when found", async () => {
    const deps = await setup({ k8s: { listHpas: async () => [helloHpa] } });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/hpa");
    expect(r.body.hpa).toMatchObject({ minReplicas: 2, maxReplicas: 10, targetCPUUtilizationPercentage: 50 });
  });

  it("GET returns 409 when the cluster lacks hpaV2 (lazy probe finds no autoscaling/v2)", async () => {
    const deps = await setup(
      { k8s: { listHpas: async () => [helloHpa], kubectl: async () => ({ code: 0, stdout: "v1\napps/v1", stderr: "" }) } },
      false, // handler lazy-probes; the fake api-versions has no autoscaling/v2
    );
    const r = await call(buildApp(deps), "GET", "/api/services/hello/hpa");
    expect(r.status).toBe(409);
  });

  it("PATCH builds a merge that preserves other metrics", async () => {
    let captured = "";
    const deps = await setup({
      k8s: { listHpas: async () => [helloHpa], patchHpa: async (_n, _ns, p) => { captured = p; return { code: 0, stdout: "", stderr: "" }; } },
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello/hpa", { targetCPUUtilizationPercentage: 80 });
    expect(r.status).toBe(200);
    const patch = JSON.parse(captured) as { spec: { metrics: Array<{ resource?: { name: string; target?: { averageUtilization?: number } } }> } };
    expect(patch.spec.metrics.find((m) => m.resource?.name === "memory")!.resource!.target!.averageUtilization).toBe(70);
    expect(patch.spec.metrics.find((m) => m.resource?.name === "cpu")!.resource!.target!.averageUtilization).toBe(80);
  });

  it("PATCH rejects min > max", async () => {
    const deps = await setup({ k8s: { listHpas: async () => [helloHpa] } });
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello/hpa", { min: 9, max: 3 });
    expect(r.status).toBe(422);
  });

  it("PATCH rejects out-of-range CPU", async () => {
    const deps = await setup({ k8s: { listHpas: async () => [helloHpa] } });
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello/hpa", { targetCPUUtilizationPercentage: 250 });
    expect(r.status).toBe(422);
  });

  it("PATCH rejects extra fields with unexpected_field", async () => {
    const deps = await setup({ k8s: { listHpas: async () => [helloHpa] } });
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello/hpa", { min: 2, behavior: { scaleUp: {} } });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("unexpected_field");
  });

  it("PATCH returns 404 when no HPA targets the workload", async () => {
    const deps = await setup({ k8s: { listHpas: async () => [] } });
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello/hpa", { min: 2 });
    expect(r.status).toBe(404);
  });

  it("a viewer cannot patch (403)", async () => {
    const deps = await setup({ k8s: { listHpas: async () => [helloHpa] } });
    const token = await signJwt({ sub: "u-viewer", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello/hpa", { min: 2 }, {
      auth: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(r.status).toBe(403);
  });
});
