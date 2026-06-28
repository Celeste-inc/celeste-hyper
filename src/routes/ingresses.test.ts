import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, TEST_JWT_SECRET } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";
import { signJwt } from "../lib/jwt.ts";

async function bearer(role: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await signJwt({ sub: `u-${role}`, role }, TEST_JWT_SECRET, { ttlSec: 3600 })}` };
}

const PATH = "/api/clusters/primary/ingresses/default/web";

describe("ingress YAML route (operator+)", () => {
  it("viewer cannot read the YAML (403)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", PATH, undefined, { auth: false, headers: await bearer("viewer") });
    expect(r.status).toBe(403);
  });

  it("operator can read the YAML (200)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", PATH, undefined, { auth: false, headers: await bearer("operator") });
    expect(r.status).toBe(200);
    expect(r.body.yaml).toContain("kind: Ingress");
  });

  it("rejects a flag-like ingress name (kubectl arg-injection guard) → 400", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/ingresses/default/--all", undefined, {
      auth: false,
      headers: await bearer("operator"),
    });
    expect(r.status).toBe(400);
  });

  it("unknown ingress returns 404", async () => {
    const deps = makeFakeDeps({ k8s: { getIngressYaml: async () => ({ code: 1, stdout: "", stderr: "NotFound" }) } });
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", PATH, undefined, { auth: false, headers: await bearer("operator") });
    expect(r.status).toBe(404);
  });
});
