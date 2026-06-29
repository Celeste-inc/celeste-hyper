import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";

const dhSearchSample = {
  count: 1,
  results: [
    { repo_name: "library/nginx", short_description: "Official nginx", star_count: 20000, pull_count: 1, is_official: true },
  ],
};

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  return deps;
}

describe("templates routes", () => {
  it("GET /api/templates lists the curated catalog", async () => {
    const r = await call(buildApp(setup()), "GET", "/api/templates");
    expect(r.status).toBe(200);
    const ids = (r.body.items as Array<{ id: string }>).map((t) => t.id);
    for (const must of ["nginx", "redis", "postgres", "mysql", "mongodb", "rabbitmq"]) {
      expect(ids).toContain(must);
    }
  });

  it("GET /api/templates/search forwards Docker Hub results via the injected fetcher", async () => {
    const deps = setup({
      fetch: async () => ({ ok: true, status: 200, json: async () => dhSearchSample }),
    } as never);
    const r = await call(buildApp(deps), "GET", "/api/templates/search?q=nginx");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([
      { name: "library/nginx", description: "Official nginx", stars: 20000, pulls: 1, official: true },
    ]);
  });

  it("GET /api/templates/search 422s when q is missing", async () => {
    const r = await call(buildApp(setup()), "GET", "/api/templates/search");
    expect(r.status).toBe(422);
  });

  it("POST /api/templates/deploy creates a registry-pull service and applies Deployment + Service + HPA manifests", async () => {
    const applied: string[] = [];
    const deps = setup({
      k8s: {
        applyManifest: async (yaml: string) => {
          applied.push(yaml);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "POST", "/api/templates/deploy", {
      templateId: "nginx",
      name: "web",
      namespace: "default",
      clusterId: "primary",
      replicas: 3,
      autoscale: { minReplicas: 2, maxReplicas: 10, targetCPUUtilizationPercentage: 70 },
    });
    expect(r.status).toBe(201);
    expect(r.body.service.name).toBe("web");
    expect(r.body.applied.map((a: { kind: string }) => a.kind).sort()).toEqual(["Deployment", "HorizontalPodAutoscaler", "Service"]);
    // The native LB: a Service that fronts the replicas via the matching app=web selector.
    const svcYaml = applied.find((y) => y.includes("kind: Service"))!;
    expect(svcYaml).toContain("name: web");
    expect(svcYaml).toContain("app: web");
    expect(svcYaml).toContain("port: 80");
    expect(r.body.loadBalancer).toMatchObject({
      kind: "ClusterIP",
      replicas: 3,
      message: expect.stringContaining("Service"),
    });
  });

  it("POST /api/templates/deploy renders a Secret manifest when secret env values are passed", async () => {
    const applied: string[] = [];
    const deps = setup({
      k8s: {
        applyManifest: async (yaml: string) => {
          applied.push(yaml);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "POST", "/api/templates/deploy", {
      templateId: "postgres",
      name: "pg",
      namespace: "data",
      clusterId: "primary",
      replicas: 1,
      env: { POSTGRES_PASSWORD: "supersecret" },
    });
    expect(r.status).toBe(201);
    expect(applied.some((y) => y.includes("kind: Secret"))).toBe(true);
  });

  it("POST /api/templates/deploy 422s when the template id is unknown", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/templates/deploy", {
      templateId: "not-a-template",
      name: "web",
      namespace: "default",
      clusterId: "primary",
      replicas: 1,
    });
    expect(r.status).toBe(422);
  });

  it("POST /api/templates/deploy 400 when the chosen cluster doesn't exist", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/templates/deploy", {
      templateId: "nginx",
      name: "web",
      namespace: "default",
      clusterId: "ghost",
      replicas: 1,
    });
    expect(r.status).toBe(400);
  });

  it("POST /api/templates/deploy 502s when a kubectl apply fails — and rolls back the registry entry", async () => {
    const deps = setup({
      k8s: {
        applyManifest: async () => ({ code: 1, stdout: "", stderr: "apply forbidden" }),
      } as never,
    });
    const r = await call(buildApp(deps), "POST", "/api/templates/deploy", {
      templateId: "nginx",
      name: "rollback-me",
      namespace: "default",
      clusterId: "primary",
      replicas: 1,
    });
    expect(r.status).toBe(502);
    expect(deps.registry.get("rollback-me")).toBeNull(); // registry row reverted
  });
});
