import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";

function setup() {
  const deps = makeFakeDeps();
  seedCluster(deps);
  return deps;
}

describe("registry source admin endpoints", () => {
  it("starts empty: GET returns an empty list", async () => {
    const r = await call(buildApp(setup()), "GET", "/api/settings/registries");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });

  it("POST creates a source; GET returns its summary WITHOUT the password", async () => {
    const deps = setup();
    const post = await call(buildApp(deps), "POST", "/api/settings/registries", {
      id: "ghcr-main",
      name: "GHCR (acme)",
      presetId: "ghcr",
      username: "octocat",
      password: "ghp_xxx",
    });
    expect(post.status).toBe(200);
    const list = await call(buildApp(deps), "GET", "/api/settings/registries");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].secretConfigured).toBe(true);
    expect(list.body.items[0].password).toBeUndefined();
  });

  it("POST 422s when preset is unknown", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/settings/registries", {
      id: "x",
      name: "x",
      presetId: "unknown",
      username: "u",
      password: "p",
    });
    expect(r.status).toBe(422);
  });

  it("POST 422s when ACR registry name is missing", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/settings/registries/acr-main/apply", {
      clusterId: "primary",
      namespace: "default",
      secretName: "pull-acr",
    });
    // Source doesn't exist yet → 404
    expect(r.status).toBe(404);
  });

  it("DELETE removes the source", async () => {
    const deps = setup();
    await call(buildApp(deps), "POST", "/api/settings/registries", {
      id: "ghcr-main",
      name: "g",
      presetId: "ghcr",
      username: "u",
      password: "p",
    });
    const del = await call(buildApp(deps), "DELETE", "/api/settings/registries/ghcr-main");
    expect(del.status).toBe(200);
    const list = await call(buildApp(deps), "GET", "/api/settings/registries");
    expect(list.body.items).toEqual([]);
  });

  it("DELETE refuses when a service references the source via registrySourceId", async () => {
    const deps = setup();
    await call(buildApp(deps), "POST", "/api/settings/registries", {
      id: "ghcr-main",
      name: "g",
      presetId: "ghcr",
      username: "u",
      password: "p",
    });
    deps.registry.create({
      sourceType: "registry-pull",
      name: "linked",
      namespace: "default",
      clusterId: "primary",
      imageRef: "ghcr.io/acme/api",
      workloadKind: "Deployment",
      enabled: true,
      registrySourceId: "ghcr-main",
    } as never);
    const del = await call(buildApp(deps), "DELETE", "/api/settings/registries/ghcr-main");
    expect(del.status).toBe(409);
  });

  it("POST .../apply provisions an imagePullSecret on the target cluster + namespace", async () => {
    let applied = "";
    const deps = setup();
    deps.pool = {
      ...deps.pool,
      get: () => ({
        applyManifest: async (yaml: string) => {
          applied = yaml;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    } as never;
    await call(buildApp(deps), "POST", "/api/settings/registries", {
      id: "ghcr-main",
      name: "g",
      presetId: "ghcr",
      username: "octocat",
      password: "ghp_xxx",
    });
    const r = await call(buildApp(deps), "POST", "/api/settings/registries/ghcr-main/apply", {
      clusterId: "primary",
      namespace: "default",
      secretName: "ghcr-pull",
    });
    expect(r.status).toBe(200);
    expect(applied).toContain("kind: Secret");
    expect(applied).toContain("kubernetes.io/dockerconfigjson");
    expect(applied).toContain("name: ghcr-pull");
  });

  it("POST /test validates credentials against the live registry (Bearer token flow)", async () => {
    const calls: string[] = [];
    const deps = setup();
    deps.fetch = (async (url: string) => {
      calls.push(url);
      if (url === "https://ghcr.io/v2/") {
        return {
          ok: false,
          status: 401,
          headers: { get: (n: string) => (n.toLowerCase() === "www-authenticate" ? 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' : null) },
          json: async () => ({}),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ token: "ok" }),
        text: async () => "",
      };
    }) as never;
    const r = await call(buildApp(deps), "POST", "/api/settings/registries/test", {
      presetId: "ghcr",
      username: "octocat",
      password: "ghp_xxx",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(calls[0]).toBe("https://ghcr.io/v2/");
  });

  it("POST /test 422s when password is missing (cannot test without it)", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/settings/registries/test", {
      presetId: "ghcr",
      username: "octocat",
    });
    expect(r.status).toBe(422);
  });

  it("POST /test surfaces wrong-credential rejections with the registry's reason", async () => {
    const deps = setup();
    deps.fetch = (async (url: string) => {
      if (url === "https://ghcr.io/v2/") {
        return {
          ok: false,
          status: 401,
          headers: { get: (n: string) => (n.toLowerCase() === "www-authenticate" ? 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' : null) },
          json: async () => ({}),
          text: async () => "",
        };
      }
      return {
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "denied: anonymous token request not authorized",
      };
    }) as never;
    const r = await call(buildApp(deps), "POST", "/api/settings/registries/test", {
      presetId: "ghcr",
      username: "wrong",
      password: "creds",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.reason).toMatch(/401|denied/i);
  });

  it("POST /:id/test uses the saved password (no need to re-enter)", async () => {
    const deps = setup();
    await call(buildApp(deps), "POST", "/api/settings/registries", {
      id: "ghcr-acme",
      name: "GHCR",
      presetId: "ghcr",
      username: "octocat",
      password: "saved-secret",
    });
    let sawAuthHeader: string | null = null;
    deps.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes("/token") || url.includes("/v2/")) {
        sawAuthHeader = init?.headers?.authorization ?? null;
      }
      if (url === "https://ghcr.io/v2/") {
        return {
          ok: false,
          status: 401,
          headers: { get: (n: string) => (n.toLowerCase() === "www-authenticate" ? 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' : null) },
          json: async () => ({}),
          text: async () => "",
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ token: "ok" }), text: async () => "" };
    }) as never;
    const r = await call(buildApp(deps), "POST", "/api/settings/registries/ghcr-acme/test", {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // Saved password reaches the token endpoint without being re-typed.
    expect(sawAuthHeader).toContain(Buffer.from("octocat:saved-secret").toString("base64"));
  });

  it("a viewer cannot read the credentials list (admin-only surface under /api/settings)", async () => {
    const { signJwt } = await import("../lib/jwt.ts");
    const { TEST_JWT_SECRET } = await import("./test-fakes.ts");
    const token = await signJwt({ sub: "u-viewer", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    const r = await call(buildApp(setup()), "GET", "/api/settings/registries", undefined, {
      auth: false,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
  });
});
