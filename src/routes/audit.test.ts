import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, pollAudit, seedCluster, seedRegistryService } from "./test-helpers.ts";
import { signJwt } from "../lib/jwt.ts";
import { TEST_JWT_SECRET } from "./test-fakes.ts";

async function viewerToken() {
  return signJwt({ sub: "vic", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
}

describe("audit trail (HTTP)", () => {
  it("records a successful mutation with the actor and ok result", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    const created = await call(app, "POST", "/api/machine-tokens", { name: "ci", role: "operator" });
    expect(created.status).toBe(201);

    const audit = await pollAudit(app, (items) => items.some((r: { action: string }) => r.action === "POST /api/machine-tokens"));
    expect(audit.status).toBe(200);
    const row = audit.body.items.find((r: { action: string }) => r.action === "POST /api/machine-tokens");
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ actor: "test-admin", role: "admin", result: "ok", resource_kind: "machine-tokens" });
  });

  it("records a failed mutation as fail", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    // unknown service → 404 from the deploy route
    const dep = await call(app, "POST", "/api/services/ghost/deploy", { tag: "v1" });
    expect(dep.status).toBe(404);
    const audit = await pollAudit(app, (items) => items.some((r: { action: string }) => r.action === "POST /api/services/ghost/deploy"));
    const row = audit.body.items.find((r: { action: string }) => r.action === "POST /api/services/ghost/deploy");
    expect(row).toMatchObject({ result: "fail", resource_kind: "services", resource_id: "ghost" });
  });

  it("does not audit reads (GET)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    await call(app, "GET", "/api/services/hello");
    const audit = await call(app, "GET", "/api/audit");
    expect(audit.body.items.some((r: { action: string }) => r.action.startsWith("GET "))).toBe(false);
  });

  it("audits a guard denial (a viewer attempting an admin mutation)", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    const vt = await viewerToken();
    const denied = await call(app, "POST", "/api/machine-tokens", { name: "x", role: "operator" }, {
      auth: false,
      headers: { authorization: `Bearer ${vt}` },
    });
    expect(denied.status).toBe(403);
    const audit = await pollAudit(app, (items) => items.some((r: { action: string; actor: string }) => r.action === "POST /api/machine-tokens" && r.actor === "vic"));
    const row = audit.body.items.find((r: { action: string; actor: string }) => r.action === "POST /api/machine-tokens" && r.actor === "vic");
    expect(row).toMatchObject({ result: "fail", actor: "vic", role: "viewer" });
  });

  it("does not audit an anonymous (unauthenticated) mutation attempt", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    const denied = await call(app, "POST", "/api/machine-tokens", { name: "x", role: "operator" }, { auth: false });
    expect(denied.status).toBe(401);
    // read the trail with a valid admin token; the anonymous attempt left no row
    const audit = await call(app, "GET", "/api/audit");
    expect(audit.body.items.some((r: { action: string }) => r.action === "POST /api/machine-tokens")).toBe(false);
  });

  it("is readable by a viewer and supports cursor pagination", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    const app = buildApp(deps);
    for (let i = 0; i < 5; i++) await call(app, "POST", "/api/machine-tokens", { name: `t${i}`, role: "viewer" });
    await pollAudit(app, (items) => items.length >= 5); // let all five onAfterResponse writes settle
    const vt = await viewerToken();
    const opts = { auth: false as const, headers: { authorization: `Bearer ${vt}` } };
    const page1 = await call(app, "GET", "/api/audit?page_size=2", undefined, opts);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await call(app, "GET", `/api/audit?page_size=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, undefined, opts);
    const ids1 = new Set(page1.body.items.map((r: { id: number }) => r.id));
    expect(page2.body.items.some((r: { id: number }) => ids1.has(r.id))).toBe(false);
  });
});
