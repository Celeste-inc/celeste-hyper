import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

type App = { handle(r: Request): Promise<Response> };

function sign(secret: string, body: unknown): { raw: string; sig: string } {
  const raw = JSON.stringify(body);
  return { raw, sig: "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") };
}

/** POST to the carve-out receiver with an explicit raw body + signature header (no bearer auth). */
async function postSigned(app: App, secretId: string, secret: string, body: unknown, overrideSig?: string) {
  const { sig } = sign(secret, body);
  return call(app, "POST", `/api/webhooks/registry/${secretId}`, body, {
    auth: false,
    headers: { "x-hub-signature-256": overrideSig ?? sig },
  });
}

async function createWebhook(app: App, kind: string) {
  const r = await call(app, "POST", "/api/webhooks", { name: "reg", kind });
  return { secretId: r.body.webhook.secretId as string, secret: r.body.secret as string, id: r.body.webhook.id as number, body: r.body };
}

describe("registry webhooks", () => {
  it("create returns the secret + URL once; list never exposes the secret", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    const w = await createWebhook(app, "dockerhub");
    expect(w.secret).toBeTruthy();
    expect(w.body.webhook.url).toBe(`/api/webhooks/registry/${w.secretId}`);
    expect(w.body.webhook).not.toHaveProperty("hmac_secret");

    const list = await call(app, "GET", "/api/webhooks");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(w.secret);
  });

  it("a bad signature returns 401 and enqueues nothing", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "api", imageRef: "acme/api" });
    const app = buildApp(deps);
    const w = await createWebhook(app, "dockerhub");
    const body = { push_data: { tag: "v2" }, repository: { repo_name: "acme/api" } };
    const bad = await postSigned(app, w.secretId, w.secret, body, "sha256=deadbeef");
    expect(bad.status).toBe(401);
    expect(deps.state.recentDeployments("api").length).toBe(0);
  });

  it("a verified push enqueues deploys for matching services", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "api", imageRef: "acme/api" }); // docker.io/acme/api after normalize
    const app = buildApp(deps);
    const w = await createWebhook(app, "dockerhub");
    const body = { push_data: { tag: "v2.0.0" }, repository: { repo_name: "acme/api" } };
    const res = await postSigned(app, w.secretId, w.secret, body);
    expect(res.status).toBe(200);
    expect(res.body.deployed).toEqual([{ service: "api", tag: "v2.0.0", deploymentId: expect.any(Number) }]);
    const depId = res.body.deployed[0].deploymentId as number;
    expect(deps.state.deploymentById(depId)!.tag).toBe("v2.0.0");
    expect(deps.queue.getJob(depId)!.kind).toBe("deploy");
  });

  it("a push with no matching service returns 200 with empty arrays", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "api", imageRef: "acme/api" });
    const app = buildApp(deps);
    const w = await createWebhook(app, "dockerhub");
    const body = { push_data: { tag: "v2" }, repository: { repo_name: "acme/unrelated" } };
    const res = await postSigned(app, w.secretId, w.secret, body);
    expect(res.status).toBe(200);
    expect(res.body.deployed).toEqual([]);
    expect(res.body.skipped).toEqual([]);
  });

  it("skips degraded services and dedups against an in-flight deploy", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "api", imageRef: "acme/api" });
    seedRegistryService(deps, { name: "api2", imageRef: "acme/api" }); // same image, two services
    deps.state.setServiceDegraded("api", "prior failure");
    const app = buildApp(deps);
    const w = await createWebhook(app, "generic");
    const body = { image: "acme/api", tag: "v3" };
    const res = await postSigned(app, w.secretId, w.secret, body);
    expect(res.status).toBe(200);
    expect(res.body.deployed.map((d: { service: string }) => d.service)).toEqual(["api2"]);
    expect(res.body.skipped).toContainEqual({ service: "api", tag: "v3", reason: "degraded" });
  });

  it("a generic multi-tag push deploys the first tag and dedups the rest for the same service", async () => {
    // Two tags for ONE service is ambiguous (a service runs one version); the per-service dedup
    // deploys the first and reports the rest as already-active rather than racing two deploys.
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "api", imageRef: "acme/api" });
    const app = buildApp(deps);
    const w = await createWebhook(app, "generic");
    const body = { image: "acme/api", tags: ["v4", "v5"] };
    const res = await postSigned(app, w.secretId, w.secret, body);
    expect(res.status).toBe(200);
    expect(res.body.deployed.map((d: { tag: string }) => d.tag)).toEqual(["v4"]);
    expect(res.body.skipped).toContainEqual({ service: "api", tag: "v5", reason: "deploy-already-active" });
  });

  it("a revoked webhook receiver returns 404", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    const w = await createWebhook(app, "dockerhub");
    expect((await call(app, "DELETE", `/api/webhooks/${w.id}`)).status).toBe(200);
    const body = { push_data: { tag: "v2" }, repository: { repo_name: "acme/api" } };
    expect((await postSigned(app, w.secretId, w.secret, body)).status).toBe(404);
  });

  it("a service-scoped webhook only deploys its bound service, even if other services match the image", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { name: "api", imageRef: "acme/api" });
    seedRegistryService(deps, { name: "api2", imageRef: "acme/api" }); // same image, different service
    const app = buildApp(deps);
    const r = await call(app, "POST", "/api/webhooks", { name: "reg", kind: "generic", serviceScope: "api" });
    expect(r.status).toBe(201);
    expect(r.body.webhook.serviceScope).toBe("api");
    const res = await postSigned(app, r.body.webhook.secretId, r.body.secret, { image: "acme/api", tag: "v9" });
    expect(res.status).toBe(200);
    expect(res.body.deployed.map((d: { service: string }) => d.service)).toEqual(["api"]); // not api2
  });

  it("does not record last_used_at on a bad signature, only after a verified call", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    const w = await createWebhook(app, "generic");
    const body = { image: "acme/api", tag: "v1" };
    await postSigned(app, w.secretId, w.secret, body, "sha256=deadbeef"); // bad sig
    let item = (await call(app, "GET", "/api/webhooks")).body.items.find((x: { id: number }) => x.id === w.id);
    expect(item.lastUsedAt).toBeNull();
    await postSigned(app, w.secretId, w.secret, body); // good sig
    item = (await call(app, "GET", "/api/webhooks")).body.items.find((x: { id: number }) => x.id === w.id);
    expect(item.lastUsedAt).not.toBeNull();
  });

  it("rejects a duplicate webhook name with 409", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    expect((await call(app, "POST", "/api/webhooks", { name: "dup", kind: "generic" })).status).toBe(201);
    expect((await call(app, "POST", "/api/webhooks", { name: "dup", kind: "generic" })).status).toBe(409);
  });

  it("rate-limits the unauthenticated receiver per IP", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    const w = await createWebhook(app, "generic");
    let saw429 = false;
    for (let i = 0; i < 35; i++) {
      const r = await postSigned(app, w.secretId, w.secret, { image: "none", tag: "v1" });
      if (r.status === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true);
  });

  it("rejects an oversized webhook body with 413", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    const w = await createWebhook(app, "generic");
    const huge = { image: "x".repeat(300_000), tag: "v1" };
    const res = await postSigned(app, w.secretId, w.secret, huge);
    expect(res.status).toBe(413);
  });

  it("the receiver is a carve-out (no bearer needed) but management requires admin", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    // management without auth → 401
    expect((await call(app, "GET", "/api/webhooks", undefined, { auth: false })).status).toBe(401);
    // receiver for an unknown secretId → 404 (reached the handler without auth)
    expect((await call(app, "POST", "/api/webhooks/registry/nonexistent", {}, { auth: false, headers: { "x-hub-signature-256": "sha256=00" } })).status).toBe(404);
  });
});
