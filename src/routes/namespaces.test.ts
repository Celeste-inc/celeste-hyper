import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, TEST_JWT_SECRET } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";
import { signJwt } from "../lib/jwt.ts";

describe("namespaces route", () => {
  it("returns namespaces with pod/workload counts", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/namespaces");
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(false);
    expect(r.body.items[0]).toMatchObject({ name: "default", podCount: 2, deploymentCount: 1 });
  });

  it("a viewer can read", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const token = await signJwt({ sub: "u-viewer", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/namespaces", undefined, {
      auth: false,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
  });

  it("kubectl failure → 502 with an error body", async () => {
    const deps = makeFakeDeps({ k8s: { namespaceCounts: async () => { throw new Error("Unable to connect to the server"); } } });
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/namespaces");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("Unable to connect");
  });

  it("unknown cluster → 404", async () => {
    const deps = makeFakeDeps({ k8s: null });
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/namespaces");
    expect(r.status).toBe(404);
  });
});
