import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call } from "./test-helpers.ts";

describe("openapi", () => {
  const EXPECTED_OPS: Array<[string, string]> = [
    ["get", "/api/health"],
    ["get", "/api/system"],
    ["get", "/api/clusters"],
    ["post", "/api/clusters"],
    ["patch", "/api/clusters/{id}"],
    ["delete", "/api/clusters/{id}"],
    ["post", "/api/clusters/{id}/check"],
    ["get", "/api/services"],
    ["get", "/api/services/{name}"],
    ["post", "/api/services"],
    ["patch", "/api/services/{name}"],
    ["delete", "/api/services/{name}"],
    ["post", "/api/services/adopt"],
    ["get", "/api/services/{name}/versions"],
    ["get", "/api/services/{name}/deployments"],
    ["post", "/api/services/{name}/deploy"],
    ["get", "/api/deployments/{id}"],
    ["get", "/api/services/{name}/pods"],
    ["get", "/api/services/{name}/networking"],
    ["get", "/api/services/{name}/logs"],
    ["get", "/api/services/{name}/env/{kind}"],
    ["put", "/api/services/{name}/env/{kind}"],
  ];

  it("GET /openapi/json → 200 documenting every /api operation", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/openapi/json");
    expect(r.status).toBe(200);
    const paths = r.body.paths ?? {};
    for (const [method, p] of EXPECTED_OPS) {
      expect(paths[p]?.[method], `${method.toUpperCase()} ${p} should be documented`).toBeDefined();
    }
  });

  it("every /api operation has a summary", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/openapi/json");
    const paths = r.body.paths ?? {};
    for (const [p, ops] of Object.entries<any>(paths)) {
      if (!p.startsWith("/api/")) continue;
      for (const [method, op] of Object.entries<any>(ops)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        expect(typeof op.summary, `${method.toUpperCase()} ${p} summary`).toBe("string");
      }
    }
  });

  it("documents every tag group", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/openapi/json");
    const names = (r.body.tags ?? []).map((t: any) => t.name);
    for (const tag of ["system", "clusters", "services", "deployments", "service-ops", "env"]) {
      expect(names).toContain(tag);
    }
  });

  it("GET /openapi → 200 Scalar UI (html)", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/openapi");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });
});
