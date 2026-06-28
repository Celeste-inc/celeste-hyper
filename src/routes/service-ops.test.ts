import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { logEvents } from "./service-ops.ts";
import { makeFakeDeps, fakeLogProc } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

const svcInfo = {
  name: "hello",
  namespace: "default",
  type: "NodePort",
  clusterIP: "10.43.7.200",
  clusterIPs: ["10.43.7.200"],
  externalIPs: [],
  ports: [{ name: "http", port: 80, targetPort: 80, nodePort: 30180, protocol: "TCP" }],
};

const pod = {
  name: "hello-6647dcb679-khrjh",
  namespace: "default",
  phase: "Running",
  containers: [{ name: "hello", image: "traefik/whoami:v1.10.4", ready: true, restartCount: 0 }],
};

describe("service-ops routes", () => {
  it("GET /api/services/:name/pods → 200 with items[]", async () => {
    const deps = makeFakeDeps({ k8s: { listPods: async () => [pod] } });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/pods");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].name).toBe(pod.name);
    expect(r.body.selector).toBe("app=hello");
  });

  it("GET /api/services/:name/networking → 200 with { service, endpoints } of the exact shape", async () => {
    const deps = makeFakeDeps({ k8s: { getServiceInfo: async () => svcInfo } });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/networking");
    expect(r.status).toBe(200);
    expect(r.body.service.name).toBe("hello");
    expect(Array.isArray(r.body.service.endpoints)).toBe(true);
    expect(r.body.service.endpoints.length).toBeGreaterThan(0);
    // every endpoint preserves the protected ServiceEndpoint shape
    for (const ep of r.body.service.endpoints) {
      expect(Object.keys(ep).sort()).toEqual(["copyable", "description", "kind", "reachableFromHost", "url"]);
      expect(["cluster-ip", "node-port", "ingress", "load-balancer"]).toContain(ep.kind);
      expect(typeof ep.url).toBe("string");
      expect(typeof ep.reachableFromHost).toBe("boolean");
    }
    // a NodePort service yields a cluster-ip and a node-port endpoint
    expect(r.body.service.endpoints.some((e: any) => e.kind === "cluster-ip")).toBe(true);
    expect(r.body.service.endpoints.some((e: any) => e.kind === "node-port")).toBe(true);
  });

  it("GET /api/services/:name/networking with no Service → { service: null, hint }", async () => {
    const deps = makeFakeDeps({ k8s: { getServiceInfo: async () => null } });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/networking");
    expect(r.status).toBe(200);
    expect(r.body.service).toBeNull();
    expect(typeof r.body.hint).toBe("string");
  });

  it("GET /api/services/:name/logs streams ordered stdout frames then end with exit code", async () => {
    const deps = makeFakeDeps({
      k8s: {
        listPods: async () => [{ name: "hello-abc", containers: [{ name: "hello" }] }],
        streamLogs: () => fakeLogProc(["line-1", "line-2", "line-3"], 7),
      },
    });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/logs?pod=hello-abc");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    // exact ordered framing: stdout lines in order, then end carrying the exit code
    expect(r.text).toBe(
      "event: stdout\ndata: line-1\n\n" +
        "event: stdout\ndata: line-2\n\n" +
        "event: stdout\ndata: line-3\n\n" +
        "event: end\ndata: 7\n\n",
    );
  });

  it("logEvents kills the subprocess immediately when the client aborts an idle stream", async () => {
    const proc = fakeLogProc([], 0, true); // follow mode: never ends on its own
    const controller = new AbortController();
    const gen = logEvents(proc as any, controller.signal);
    const pending = gen.next(); // starts the generator; it parks waiting for a line
    controller.abort();
    const result = await pending;
    expect(result.done).toBe(true);
    expect(proc.killed).toBe(true);
  });

  it("GET /api/services/:name/logs without pod → 400", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/logs");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("pod");
  });

  it("GET /api/services/:name/logs unknown service → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/api/services/ghost/logs?pod=p");
    expect(r.status).toBe(404);
  });

  it("GET /api/services/:name/logs with no cluster configured → 500", async () => {
    const deps = makeFakeDeps({ k8s: null }); // pool.get → null
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/logs?pod=p");
    expect(r.status).toBe(500);
    expect(r.body.error).toContain("not configured");
  });

  it("GET /api/services/:name/pods with no cluster configured → 200 { items: [] }", async () => {
    const deps = makeFakeDeps({ k8s: null });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/pods");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});
