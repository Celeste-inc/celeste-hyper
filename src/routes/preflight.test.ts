import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService, seedR2Service } from "./test-helpers.ts";

describe("GET /api/services/:name/preflight", () => {
  it("returns ok:true when the server dry-run passes", async () => {
    const deps = makeFakeDeps({ k8s: { kubectl: async () => ({ code: 0, stdout: "configured (server dry run)", stderr: "" }) } });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/preflight?tag=v2");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ applicable: true, ok: true });
  });

  it("returns the denial reason when admission rejects", async () => {
    const deps = makeFakeDeps({ k8s: { kubectl: async () => ({ code: 1, stdout: "", stderr: 'admission webhook denied: unsigned image' }) } });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/preflight?tag=v2");
    expect(r.body).toMatchObject({ applicable: true, ok: false });
    expect(r.body.reason).toContain("denied");
  });

  it("is applicable:false for an r2-bundle service", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedR2Service(deps); // "pay"
    const r = await call(buildApp(deps), "GET", "/api/services/pay/preflight?tag=v1");
    expect(r.body).toEqual({ applicable: false });
  });

  it("400 without a tag, 404 for an unknown service", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    expect((await call(app, "GET", "/api/services/hello/preflight")).status).toBe(400);
    expect((await call(app, "GET", "/api/services/ghost/preflight?tag=v1")).status).toBe(404);
  });

  it("is operator-gated: a viewer is forbidden (it drives admission + exposes policy internals)", async () => {
    const deps = makeFakeDeps({ k8s: { kubectl: async () => ({ code: 0, stdout: "", stderr: "" }) } });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/preflight?tag=v2", undefined, { auth: false, headers: { authorization: `Bearer ${await viewer()}` } });
    expect(r.status).toBe(403);
  });
});

import { signJwt } from "../lib/jwt.ts";
import { TEST_JWT_SECRET } from "./test-fakes.ts";
const viewer = () => signJwt({ sub: "v", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
