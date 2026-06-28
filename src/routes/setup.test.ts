import { describe, expect, it } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";

describe("setup routes", () => {
  it("GET /api/settings/r2 returns redacted current settings", async () => {
    const deps = makeFakeDeps();
    const r = await call(buildApp(deps), "GET", "/api/settings/r2");
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe("test-bucket");
    expect(r.body.secretAccessKey).toBeUndefined();
    expect(r.body.secretConfigured).toBe(true);
  });

  it("PUT /api/settings/r2 persists and updates the runtime R2 client", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const r = await call(app, "PUT", "/api/settings/r2", {
      endpoint: "https://new.r2.test",
      bucket: "new-bucket",
      accessKeyId: "new-key",
      secretAccessKey: "new-secret",
      region: "auto",
    });
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe("new-bucket");
    expect(deps.r2.getConfig().bucket).toBe("new-bucket");
    expect(deps.state.getMeta("settings.r2.bucket")).toBe("new-bucket");
  });

  it("POST /api/setup/bootstrap registers selected r2-bundle services and env files", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps, { id: "local", defaultNamespace: "production" });
    const r = await call(buildApp(deps), "POST", "/api/setup/bootstrap", {
      clusterId: "local",
      namespace: "production",
      services: [
        { name: "api", r2Prefix: "api/", configEnv: "LOG_LEVEL=info\n", secretEnv: "API_KEY=\n" },
        { name: "worker", r2Prefix: "worker/", configEnv: "", secretEnv: "" },
      ],
      writeEnvTemplates: true,
      overwriteEnvTemplates: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.items.map((item: any) => item.service)).toEqual(["api", "worker"]);
    expect(deps.registry.get("api")?.sourceType).toBe("r2-bundle");
    expect((deps.registry.get("api") as any)?.r2Prefix).toBe("api/");
    expect(deps.registry.get("worker")?.namespace).toBe("production");
    expect(r.body.items[1].env).toEqual({ config: "created", secret: "created" });
  });

  it("setup endpoints are admin-only", async () => {
    const deps = makeFakeDeps();
    const r = await call(buildApp(deps), "GET", "/api/setup/status", undefined, { auth: false });
    expect(r.status).toBe(401);
  });
});
