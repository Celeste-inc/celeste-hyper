import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";
import { fakeClock } from "../lib/clock.ts";

const asMachine = (token: string) => ({ auth: false as const, headers: { authorization: `Bearer ${token}` } });

async function createToken(app: { handle(r: Request): Promise<Response> }, body: object) {
  return call(app, "POST", "/api/machine-tokens", body);
}

describe("machine tokens", () => {
  it("create returns the cleartext exactly once; list never exposes it or the hash", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);

    const created = await createToken(app, { name: "ci", role: "operator" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^cht_/);
    expect(created.body.machineToken).not.toHaveProperty("hash_sha256");
    expect(created.body.machineToken).not.toHaveProperty("token");

    const list = await call(app, "GET", "/api/machine-tokens");
    expect(list.status).toBe(200);
    const row = list.body.items.find((t: { name: string }) => t.name === "ci");
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty("token");
    expect(row).not.toHaveProperty("hash_sha256");
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
  });

  it("a valid machine token authenticates as a bearer", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    const token = (await createToken(app, { name: "ci", role: "operator" })).body.token;

    const me = await call(app, "GET", "/api/services", undefined, asMachine(token));
    expect(me.status).toBe(200);
  });

  it("a revoked token returns 401 on the next request", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    const created = await createToken(app, { name: "ci", role: "operator" });
    const token = created.body.token as string;
    const id = created.body.machineToken.id as number;

    expect((await call(app, "GET", "/api/services", undefined, asMachine(token))).status).toBe(200);
    const del = await call(app, "DELETE", `/api/machine-tokens/${id}`);
    expect(del.status).toBe(200);
    expect((await call(app, "GET", "/api/services", undefined, asMachine(token))).status).toBe(401);
    // a second revoke is a 404 (already revoked)
    expect((await call(app, "DELETE", `/api/machine-tokens/${id}`)).status).toBe(404);
  });

  it("an expired token returns 401", async () => {
    const clock = fakeClock(0);
    const deps = makeFakeDeps({ clock });
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    const token = (await createToken(app, { name: "ci", role: "operator", expiresInDays: 1 })).body.token;

    expect((await call(app, "GET", "/api/services", undefined, asMachine(token))).status).toBe(200);
    clock.advance(2 * 86_400_000); // two days later
    expect((await call(app, "GET", "/api/services", undefined, asMachine(token))).status).toBe(401);
  });

  it("machine tokens cannot be admin and cannot manage other tokens", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    // role=admin is rejected by the schema
    expect((await createToken(app, { name: "x", role: "admin" })).status).toBe(422);
    // an operator token is forbidden from the admin-only machine-tokens surface
    const token = (await createToken(app, { name: "ci", role: "operator" })).body.token;
    expect((await call(app, "GET", "/api/machine-tokens", undefined, asMachine(token))).status).toBe(403);
  });

  it("a service-scoped token can deploy its service but not others", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps); // "hello"
    seedRegistryService(deps, { name: "other" });
    const app = buildApp(deps);
    const token = (await createToken(app, { name: "ci", role: "operator", serviceScope: "hello" })).body.token;

    expect((await call(app, "POST", "/api/services/hello/deploy", { tag: "v1" }, asMachine(token))).status).toBe(202);
    const blocked = await call(app, "POST", "/api/services/other/deploy", { tag: "v1" }, asMachine(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("out_of_scope");
    // it also can't read another service
    expect((await call(app, "GET", "/api/services/other", undefined, asMachine(token))).status).toBe(403);
  });

  it("enforces scope on the logs carve-out (a scoped token cannot read another service's logs)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps); // "hello"
    seedRegistryService(deps, { name: "other" });
    const app = buildApp(deps);
    const token = (await createToken(app, { name: "ci", role: "operator", serviceScope: "hello" })).body.token;

    // out of scope → 401 even though /logs is a global-guard carve-out
    expect((await call(app, "GET", "/api/services/other/logs", undefined, asMachine(token))).status).toBe(401);
    // in scope → reaches the handler (asks for the pod param), i.e. NOT a scope rejection
    expect((await call(app, "GET", "/api/services/hello/logs", undefined, asMachine(token))).status).toBe(400);
  });

  it("a cluster-scoped token can deploy services in its cluster but not other clusters", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps); // primary
    seedCluster(deps, { id: "edge", name: "Edge" });
    seedRegistryService(deps); // "hello" on primary
    seedRegistryService(deps, { name: "edge-svc", clusterId: "edge" });
    const app = buildApp(deps);
    const token = (await createToken(app, { name: "ci", role: "operator", clusterScope: "primary" })).body.token;

    expect((await call(app, "POST", "/api/services/hello/deploy", { tag: "v1" }, asMachine(token))).status).toBe(202);
    const blocked = await call(app, "POST", "/api/services/edge-svc/deploy", { tag: "v1" }, asMachine(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("out_of_scope");
  });

  it("rejects an unknown scope target and a duplicate name", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    expect((await createToken(app, { name: "a", role: "operator", serviceScope: "ghost" })).status).toBe(400);
    expect((await createToken(app, { name: "a", role: "operator", clusterScope: "ghost" })).status).toBe(400);
    expect((await createToken(app, { name: "dup", role: "operator" })).status).toBe(201);
    expect((await createToken(app, { name: "dup", role: "operator" })).status).toBe(409);
  });
});
