import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";
import { fakeClock } from "../lib/clock.ts";
import { VERSION } from "../version.ts";

describe("system routes", () => {
  it("GET /api/health → 200 with { ok } still present (liveness probe contract)", async () => {
    const app = buildApp(makeFakeDeps());
    const r = await call(app, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("GET /api/health is promoted with version/uptime/lastTick/cluster+job counts (CC.2)", async () => {
    const clock = fakeClock(10_000);
    const deps = makeFakeDeps({ clock, snapshot: { lastTickAt: "2026-06-28T00:00:00.000Z", lastDurationMs: 1, lastError: null } });
    seedCluster(deps);
    const app = buildApp(deps);
    deps.queue.enqueue({ kind: "deploy", resourceKind: "service", resourceId: "hello", payload: { tag: "v1" } });
    clock.advance(5_000); // 5s elapsed since boot
    const r = await call(app, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      version: VERSION,
      lastTickAt: "2026-06-28T00:00:00.000Z",
      clusterCount: 1,
      jobCount: 1,
    });
    expect(r.body.uptimeSec).toBe(5);
  });

  it("GET /api/health clamps uptimeSec to 0 if the wall clock steps backward", async () => {
    const clock = fakeClock(10_000);
    const deps = makeFakeDeps({ clock });
    const app = buildApp(deps);
    clock.advance(-6_000); // NTP/VM time correction moves now() before boot
    const r = await call(app, "GET", "/api/health");
    expect(r.body.uptimeSec).toBe(0);
  });

  it("GET /api/health reports a null lastTickAt and zero counts before the first tick", async () => {
    const app = buildApp(makeFakeDeps());
    const r = await call(app, "GET", "/api/health");
    expect(r.body.lastTickAt).toBeNull();
    expect(r.body.clusterCount).toBe(0);
    expect(r.body.jobCount).toBe(0);
  });

  it("GET /api/system → 200 with { clusters, poller, r2 } shape", async () => {
    const deps = makeFakeDeps({ snapshot: { lastTickAt: "2026-06-28T00:00:00.000Z", lastDurationMs: 42, lastError: null } });
    seedCluster(deps);
    const app = buildApp(deps);
    const r = await call(app, "GET", "/api/system");
    expect(r.status).toBe(200);
    expect(r.body.clusters).toBe(1);
    expect(r.body.poller).toEqual({
      enabled: true,
      intervalSec: 15,
      autoDeploy: false,
      lastTickAt: "2026-06-28T00:00:00.000Z",
      lastDurationMs: 42,
      lastError: null,
    });
    expect(r.body.r2).toEqual({ endpoint: "https://r2.test", bucket: "test-bucket" });
  });
});
