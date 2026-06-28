import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

describe("cluster routes", () => {
  it("GET /api/clusters → 200 with items[]", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/clusters");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].id).toBe("primary");
    expect(r.body.items[0].health.clusterId).toBe("primary");
    expect(r.body.items[0].serviceCount).toBe(0);
  });

  it("GET /api/clusters surfaces kubectl<->apiserver version skew (CC.5)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    deps.state.setMeta("kubectl_version", "v1.33.0"); // probed kubectl client (host-level)
    deps.state.setClusterCapabilities("primary", "{}", "2026-06-28T00:00:00.000Z", "v1.31.0"); // apiserver
    const r = await call(buildApp(deps), "GET", "/api/clusters");
    const item = r.body.items[0];
    expect(item.kubectlVersion).toBe("v1.33.0");
    expect(item.serverVersion).toBe("v1.31.0");
    expect(item.versionSkew.ok).toBe(false); // 33 vs 31 = 2 minor > 1
    expect(item.versionSkew.reason).toContain("minor");
  });

  it("GET /api/clusters reports ok skew when versions are unknown or in range", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/clusters");
    expect(r.body.items[0].versionSkew.ok).toBe(true); // null vs null → no false alarm
    expect(r.body.items[0].kubectlVersion).toBeNull();
  });

  it("POST /api/clusters valid → 201 { cluster } with defaults applied", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/clusters", {
      id: "c1",
      name: "C1",
      kubeconfigPath: "/k",
    });
    expect(r.status).toBe(201);
    expect(r.body.cluster.id).toBe("c1");
    expect(r.body.cluster.defaultNamespace).toBe("default");
    expect(r.body.cluster.runtime).toBe("auto");
    expect(r.body.cluster.enabled).toBe(true);
  });

  it("POST /api/clusters duplicate id → 409 { error }", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps, { id: "dup" });
    const r = await call(buildApp(deps), "POST", "/api/clusters", { id: "dup", name: "X", kubeconfigPath: "/k" });
    expect(r.status).toBe(409);
    expect(typeof r.body.error).toBe("string");
  });

  it("POST /api/clusters invalid body → 422 { error, issues }", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/clusters", { name: "no id or kubeconfig" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("invalid body");
    expect(Array.isArray(r.body.issues)).toBe(true);
  });

  it("PATCH /api/clusters/:id valid → 200 { cluster }", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps, { id: "c1", name: "Old" });
    const r = await call(buildApp(deps), "PATCH", "/api/clusters/c1", { name: "New" });
    expect(r.status).toBe(200);
    expect(r.body.cluster.name).toBe("New");
  });

  it("PATCH /api/clusters/:id immutable id rejected → 400", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps, { id: "c1" });
    const r = await call(buildApp(deps), "PATCH", "/api/clusters/c1", { id: "c2" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("immutable");
  });

  it("DELETE /api/clusters/:id with services attached → 409 { error }", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps); // points at "primary"
    const r = await call(buildApp(deps), "DELETE", "/api/clusters/primary");
    expect(r.status).toBe(409);
    expect(typeof r.body.error).toBe("string");
  });

  it("DELETE /api/clusters/:id unknown → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "DELETE", "/api/clusters/ghost");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("cluster not found");
  });

  it("POST /api/clusters/:id/check → 200 with { health } and refreshed capabilities", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "POST", "/api/clusters/primary/check");
    expect(r.status).toBe(200);
    expect(r.body.health.clusterId).toBe("primary");
    expect(r.body.health.ok).toBe(true);
    expect(r.body.capabilities.hpaV2.value).toBe(true); // probed from the fake api-versions
  });

  it("POST /api/clusters/:id/workload-overrides persists a classification override", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "POST", "/api/clusters/primary/workload-overrides", {
      namespace: "shop",
      kind: "Deployment",
      name: "web",
      category: "infrastructure",
    });
    expect(r.status).toBe(200);
    expect(deps.state.workloadOverrides("primary").get("shop/Deployment/web")).toBe("infrastructure");
  });

  it("POST /api/clusters triggers a capability probe; the next GET reflects it", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const created = await call(app, "POST", "/api/clusters", { id: "edge", name: "Edge", kubeconfigPath: "/k" });
    expect(created.status).toBe(201);
    const list = await call(app, "GET", "/api/clusters");
    const edge = (list.body.items as Array<{ id: string; capabilities: Record<string, { value: boolean; source: string }> }>)
      .find((c) => c.id === "edge")!;
    expect(edge.capabilities.hpaV2!.value).toBe(true); // cluster-level, from the registration probe
    expect(edge.capabilities.hpaV2!.source).toBe("cluster");
  });
});
