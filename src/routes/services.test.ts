import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService, seedR2Service } from "./test-helpers.ts";

describe("service routes", () => {
  it("GET /api/services → 200 with fully-shaped items[] (cluster branch) + unmanaged[]", async () => {
    const deps = makeFakeDeps({
      snapshot: {
        lastTickAt: "2026-06-28T00:00:00.000Z",
        newVersions: { hello: "v2.0.0" },
        cluster: [
          // a managed workload matching the seeded "hello" service → exercises the cluster:{} branch
          {
            clusterId: "primary",
            kind: "Deployment",
            name: "hello",
            namespace: "default",
            replicas: 2,
            readyReplicas: 2,
            containers: [{ name: "hello", image: "traefik/whoami:v1.10.4" }],
            managed: true,
          } as any,
          {
            clusterId: "edge",
            kind: "Deployment",
            name: "edge-echo",
            namespace: "edge-apps",
            replicas: 1,
            readyReplicas: 1,
            containers: [{ name: "edge-echo", image: "traefik/whoami:v1.10" }],
            managed: false,
          } as any,
        ],
      },
    });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    const item = r.body.items[0];
    expect(item.name).toBe("hello");
    expect(item.currentTag).toBeNull();
    expect(item.deployedAt).toBeNull();
    expect(item.newVersion).toBe("v2.0.0");
    expect(item.cluster).toEqual({
      kind: "Deployment",
      replicas: 2,
      readyReplicas: 2,
      containers: [{ name: "hello", image: "traefik/whoami:v1.10.4" }],
    });
    expect(Object.keys(item.env).sort()).toEqual(["config", "secret"]);
    for (const kind of ["config", "secret"] as const) {
      expect(Object.keys(item.env[kind]).sort()).toEqual(["exists", "keys", "path"]);
    }
    expect(r.body.unmanaged).toHaveLength(1);
    expect(r.body.unmanaged[0].name).toBe("edge-echo");
    expect(r.body.lastTickAt).toBe("2026-06-28T00:00:00.000Z");
  });

  it("splits discovered workloads into unmanaged (application) and infrastructure by category", async () => {
    const deps = makeFakeDeps({
      snapshot: {
        cluster: [
          { clusterId: "primary", kind: "Deployment", name: "shop-web", namespace: "shop", replicas: 1, readyReplicas: 1, containers: [{ name: "w", image: "x:1" }], managed: false, category: "application" } as never,
          { clusterId: "primary", kind: "Deployment", name: "coredns", namespace: "kube-system", replicas: 2, readyReplicas: 2, containers: [{ name: "c", image: "coredns:1" }], managed: false, category: "infrastructure" } as never,
        ],
      },
    });
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/services");
    expect(r.body.unmanaged.map((w: { name: string }) => w.name)).toEqual(["shop-web"]);
    expect(r.body.infrastructure.map((w: { name: string }) => w.name)).toEqual(["coredns"]);
  });

  it("adopting a workload writes an application override so it won't re-classify", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/adopt", {
      namespace: "kube-system",
      clusterId: "primary",
      workloadKind: "Deployment",
      workloadName: "promoted",
      containerName: "promoted",
      imageRef: "traefik/whoami",
    });
    expect(r.status).toBe(201);
    expect(deps.state.workloadOverrides("primary").get("kube-system/Deployment/promoted")).toBe("application");
  });

  it("PATCH { deployMode: canary } persists on a registry-pull Deployment", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps); // hello, registry-pull, Deployment
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello", { sourceType: "registry-pull", deployMode: "canary" });
    expect(r.status).toBe(200);
    expect(r.body.service.deployMode).toBe("canary");
  });

  it("PATCH canary/blue-green on a non-Deployment workload → 422 mode-workload-mismatch", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "sts", workloadKind: "StatefulSet" });
    const r = await call(buildApp(deps), "PATCH", "/api/services/sts", { sourceType: "registry-pull", deployMode: "blue-green" });
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe("mode-workload-mismatch");
  });

  it("rejects canary + a same-body workloadKind change to a non-Deployment (422)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps); // hello, Deployment
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello", { sourceType: "registry-pull", workloadKind: "StatefulSet", deployMode: "canary" });
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe("mode-workload-mismatch");
  });

  it("a partial PATCH does not clobber unspecified fields with schema defaults", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "sts", workloadKind: "StatefulSet", namespace: "data" });
    const r = await call(buildApp(deps), "PATCH", "/api/services/sts", { sourceType: "registry-pull", enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.service.workloadKind).toBe("StatefulSet"); // not reset to the Deployment default
    expect(r.body.service.namespace).toBe("data"); // not reset to "default"
    expect(r.body.service.enabled).toBe(false);
  });

  it("GET /api/services/:name → 200 with exact { service, currentTag, deployedAt } shape", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const svc = seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ service: svc, currentTag: null, deployedAt: null });
  });

  it("GET /api/services/:name unknown → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/api/services/ghost");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("service not found");
  });

  it("POST /api/services valid registry-pull → 201", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "POST", "/api/services", {
      sourceType: "registry-pull",
      name: "checkout",
      clusterId: "primary",
      imageRef: "myacr.azurecr.io/checkout",
    });
    expect(r.status).toBe(201);
    expect(r.body.service.name).toBe("checkout");
    expect(r.body.service.workloadKind).toBe("Deployment");
  });

  it("POST /api/services valid r2-bundle → 201", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "POST", "/api/services", {
      sourceType: "r2-bundle",
      name: "payments",
      clusterId: "primary",
      r2Prefix: "payments/",
    });
    expect(r.status).toBe(201);
    expect(r.body.service.sourceType).toBe("r2-bundle");
  });

  it("POST /api/services unknown cluster → 400", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/services", {
      sourceType: "registry-pull",
      name: "x",
      clusterId: "ghost",
      imageRef: "img",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("ghost");
  });

  it("POST /api/services/adopt → 201", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/adopt", {
      namespace: "default",
      clusterId: "primary",
      workloadName: "edge-echo",
      containerName: "edge-echo",
      imageRef: "traefik/whoami",
    });
    expect(r.status).toBe(201);
    expect(r.body.service.name).toBe("edge-echo");
    expect(r.body.service.sourceType).toBe("registry-pull");
  });

  it("PATCH /api/services/:name sourceType change → 400", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "PATCH", "/api/services/hello", { sourceType: "r2-bundle" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("sourceType cannot be changed");
  });

  it("DELETE /api/services/:name unknown → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "DELETE", "/api/services/ghost");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("service not found");
  });

  it("GET /api/services/:name/versions r2-bundle → items + source: r2", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedR2Service(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/pay/versions");
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("r2");
    expect(Array.isArray(r.body.items)).toBe(true);
  });
});
