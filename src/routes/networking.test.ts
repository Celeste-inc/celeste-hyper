import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

const svcInfo = {
  name: "hello",
  namespace: "default",
  type: "ClusterIP",
  clusterIP: "10.43.7.200",
  ports: [{ name: "http", port: 80, protocol: "TCP" }],
  externalIPs: [],
};
const ingress = { host: "app.example.com", path: "/", tls: false, ingressName: "web" };

function setup(over: Parameters<typeof makeFakeDeps>[0] = {}) {
  const deps = makeFakeDeps({
    k8s: { getServiceInfo: async () => svcInfo, listIngressesFor: async () => [ingress] },
    ...over,
  });
  seedCluster(deps);
  seedRegistryService(deps);
  return deps;
}

function ingressEndpoint(body: { service: { endpoints: Array<{ kind: string; source?: unknown; dns?: unknown }> } }) {
  return body.service.endpoints.find((e) => e.kind === "ingress")!;
}

describe("networking endpoint source + DNS", () => {
  it("sets source { kind, ingressName, ingressNamespace } on ingress entries", async () => {
    const r = await call(buildApp(setup()), "GET", "/api/services/hello/networking");
    expect(r.status).toBe(200);
    const ep = ingressEndpoint(r.body);
    expect(ep.source).toEqual({ kind: "ingress", ingressName: "web", ingressNamespace: "default" });
  });

  it("attaches a DNS hint for a resolvable ingress host", async () => {
    const deps = setup({ dns: async () => ({ resolved: true, addresses: ["1.2.3.4"], elapsedMs: 7 }) });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/networking");
    expect(ingressEndpoint(r.body).dns).toEqual({ resolved: true, addresses: ["1.2.3.4"], elapsedMs: 7 });
  });

  it("reports a DNS timeout in the hint", async () => {
    const deps = setup({ dns: async () => ({ resolved: false, reason: "timeout after 200ms" }) });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/networking");
    expect(ingressEndpoint(r.body).dns).toEqual({ resolved: false, reason: "timeout after 200ms" });
  });
});
