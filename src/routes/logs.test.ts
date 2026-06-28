import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, fakeLogProc, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";
import { logEvents } from "./service-ops.ts";
import { fakeClock } from "../lib/clock.ts";

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  seedRegistryService(deps);
  return { deps, app: buildApp(deps) };
}

// k8s fake whose listPods returns a single pod `p` backing the service, so the ownership
// check passes; streamLogs yields one line.
function streamingK8s(): FakeDepsOptions["k8s"] {
  return {
    listPods: async () => [{ name: "p", containers: [{ name: "app" }] }],
    streamLogs: () => fakeLogProc(["line-1"]),
  };
}

describe("logs token endpoint", () => {
  it("requires auth", async () => {
    const { app } = setup();
    expect((await call(app, "POST", "/api/services/hello/logs/token", undefined, { auth: false })).status).toBe(401);
  });

  it("mints a token for an authed user", async () => {
    const { app } = setup();
    const r = await call(app, "POST", "/api/services/hello/logs/token"); // default admin bearer
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe("string");
    expect(typeof r.body.expiresAt).toBe("string");
  });
});

describe("logs SSE auth", () => {
  it("rejects a stream with no token and no session (401)", async () => {
    const { app } = setup({ k8s: { streamLogs: () => fakeLogProc(["x"]) } });
    expect((await call(app, "GET", "/api/services/hello/logs?pod=p", undefined, { auth: false })).status).toBe(401);
  });

  it("streams with a valid token; the token is single-use (reuse → 401)", async () => {
    const { app } = setup({ k8s: streamingK8s() });
    const token = (await call(app, "POST", "/api/services/hello/logs/token")).body.token as string;

    const first = await call(app, "GET", `/api/services/hello/logs?logToken=${token}&pod=p`, undefined, { auth: false });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    expect(first.text).toContain("data: line-1");

    const reuse = await call(app, "GET", `/api/services/hello/logs?logToken=${token}&pod=p`, undefined, { auth: false });
    expect(reuse.status).toBe(401);
  });

  it("rejects a pod that does not back the service (404)", async () => {
    const { app } = setup({ k8s: streamingK8s() }); // only pod `p` backs the service
    const token = (await call(app, "POST", "/api/services/hello/logs/token")).body.token as string;
    const r = await call(app, "GET", `/api/services/hello/logs?logToken=${token}&pod=someone-elses-pod`, undefined, { auth: false });
    expect(r.status).toBe(404);
  });

  it("rejects an expired token (401)", async () => {
    const clock = fakeClock(0);
    const { app } = setup({ clock, k8s: { streamLogs: () => fakeLogProc(["x"]) } });
    const token = (await call(app, "POST", "/api/services/hello/logs/token")).body.token as string;
    clock.advance(61_000); // past the 60s TTL
    const r = await call(app, "GET", `/api/services/hello/logs?logToken=${token}&pod=p`, undefined, { auth: false });
    expect(r.status).toBe(401);
  });

  it("still accepts cookie/bearer auth (curl/scripts)", async () => {
    const { app } = setup({ k8s: streamingK8s() });
    const r = await call(app, "GET", "/api/services/hello/logs?pod=p"); // default admin bearer
    expect(r.status).toBe(200);
    expect(r.text).toContain("data: line-1");
  });
});

describe("logEvents heartbeat + disconnect", () => {
  it("emits a heartbeat every 15s (fake clock)", async () => {
    const proc = fakeLogProc([], 0, true); // follow mode: never ends on its own
    const clock = fakeClock(0);
    const controller = new AbortController();
    const gen = logEvents(proc as never, controller.signal, clock);
    const pending = gen.next();
    clock.advance(15_000);
    const r = await pending;
    expect((r.value as { event?: string } | undefined)?.event).toBe("heartbeat");
    controller.abort(); // clean up the parked generator + timer
    await gen.next();
  });

  it("kills the kubectl process on client disconnect", async () => {
    const proc = fakeLogProc([], 0, true);
    const controller = new AbortController();
    const gen = logEvents(proc as never, controller.signal, fakeClock(0));
    const pending = gen.next();
    controller.abort();
    const r = await pending;
    expect(r.done).toBe(true);
    expect(proc.killed).toBe(true);
  });
});
