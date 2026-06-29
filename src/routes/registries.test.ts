import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";

function setup() {
  const deps = makeFakeDeps();
  seedCluster(deps);
  return deps;
}

describe("registry presets route", () => {
  it("GET /api/registries/presets lists the well-known providers", async () => {
    const r = await call(buildApp(setup()), "GET", "/api/registries/presets");
    expect(r.status).toBe(200);
    const ids = (r.body.items as Array<{ id: string }>).map((p) => p.id).sort();
    expect(ids).toEqual(["acr", "docker-hub", "ecr", "ghcr", "harbor", "quay"]);
    // Each preset must expose the labels the UI renders without round-tripping the catalog.
    for (const p of r.body.items) {
      expect(p.label).toBeTruthy();
      expect(p.auth.usernameLabel).toBeTruthy();
    }
  });

  it("POST /api/registries/compose returns the assembled imageRef for the chosen preset", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/registries/compose", {
      presetId: "ghcr",
      namespace: "acme",
      image: "api",
    });
    expect(r.status).toBe(200);
    expect(r.body.imageRef).toBe("ghcr.io/acme/api");
  });

  it("POST /api/registries/compose returns 422 when the preset needs a registry name that's missing", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/registries/compose", {
      presetId: "acr",
      namespace: "prod",
      image: "api",
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/registry/i);
  });

  it("POST /api/registries/compose returns 422 for an unknown preset id", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/registries/compose", {
      presetId: "fly-io",
      namespace: "x",
      image: "y",
    });
    expect(r.status).toBe(422);
  });

  it("POST /api/registries/pull-secret applies a docker-config Secret on the chosen cluster + namespace", async () => {
    let appliedYaml = "";
    const deps = setup();
    deps.pool = {
      ...deps.pool,
      get: () => ({
        applyManifest: async (yaml: string) => {
          appliedYaml = yaml;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
      getOrThrow: () => ({
        applyManifest: async (yaml: string) => {
          appliedYaml = yaml;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    } as never;
    const r = await call(buildApp(deps), "POST", "/api/registries/pull-secret", {
      clusterId: "primary",
      namespace: "default",
      secretName: "ghcr-pull",
      preset: { presetId: "ghcr", username: "octocat", password: "ghp_xyz" },
    });
    expect(r.status).toBe(200);
    expect(r.body.secretName).toBe("ghcr-pull");
    expect(appliedYaml).toContain("kind: Secret");
    expect(appliedYaml).toContain("kubernetes.io/dockerconfigjson");
  });

  it("POST /api/registries/pull-secret 422s on an invalid secret name", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/registries/pull-secret", {
      clusterId: "primary",
      namespace: "default",
      secretName: "Invalid Name!",
      preset: { presetId: "ghcr", username: "u", password: "p" },
    });
    expect(r.status).toBe(422);
  });

  it("POST /api/registries/pull-secret 404s when the cluster is unknown", async () => {
    const r = await call(buildApp(setup()), "POST", "/api/registries/pull-secret", {
      clusterId: "ghost",
      namespace: "default",
      secretName: "x-pull",
      preset: { presetId: "ghcr", username: "u", password: "p" },
    });
    expect(r.status).toBe(404);
  });
});
