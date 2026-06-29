import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";

const servicesJson = JSON.stringify({
  items: [
    {
      metadata: { name: "alpha", namespace: "default" },
      spec: {
        type: "NodePort",
        clusterIP: "10.0.0.1",
        ports: [{ name: "http", port: 80, targetPort: 8080, nodePort: 30080, protocol: "TCP" }],
      },
    },
    {
      metadata: { name: "beta", namespace: "default" },
      spec: {
        type: "ClusterIP",
        clusterIP: "10.0.0.2",
        ports: [{ port: 6379, protocol: "TCP" }],
      },
    },
    {
      metadata: { name: "gamma", namespace: "team-b" },
      spec: {
        type: "NodePort",
        clusterIP: "10.0.0.3",
        ports: [{ port: 80, nodePort: 30081 }],
      },
    },
  ],
});

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  return deps;
}

describe("ports route", () => {
  it("GET /api/clusters/:id/ports returns one row per (service, port) plus summary", async () => {
    const deps = setup({
      k8s: {
        kubectl: async (args) => {
          if (args[0] === "get" && args[1] === "services") {
            return { code: 0, stdout: servicesJson, stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/ports");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(3);
    expect(r.body.items[0]).toMatchObject({ service: "alpha", port: 80, nodePort: 30080 });
    expect(r.body.summary).toMatchObject({
      totalServicePorts: 3,
      totalNodePorts: 2,
      namespaces: ["default", "team-b"],
    });
    expect(r.body.summary.nodePorts.sort((a: number, b: number) => a - b)).toEqual([30080, 30081]);
  });

  it("GET /api/clusters/:id/ports?check returns conflicts for an expose request", async () => {
    const deps = setup({
      k8s: {
        kubectl: async (args) => {
          if (args[0] === "get" && args[1] === "services") {
            return { code: 0, stdout: servicesJson, stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const qs = "namespace=default&type=NodePort&port=80&nodePort=30080";
    const r = await call(buildApp(deps), "GET", `/api/clusters/primary/ports/check?${qs}`);
    expect(r.status).toBe(200);
    expect(r.body.conflicts).toHaveLength(2);
    expect(r.body.allocation.port).not.toBe(80);
    expect(r.body.allocation.nodePort).not.toBe(30080);
  });

  it("GET /api/clusters/:id/ports?check returns no conflicts when the request is free", async () => {
    const deps = setup({
      k8s: {
        kubectl: async (args) => {
          if (args[0] === "get" && args[1] === "services") {
            return { code: 0, stdout: servicesJson, stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const qs = "namespace=default&type=ClusterIP&port=9090";
    const r = await call(buildApp(deps), "GET", `/api/clusters/primary/ports/check?${qs}`);
    expect(r.status).toBe(200);
    expect(r.body.conflicts).toEqual([]);
    expect(r.body.allocation.port).toBe(9090);
  });

  it("404s when the cluster does not exist", async () => {
    const deps = setup();
    const r = await call(buildApp(deps), "GET", "/api/clusters/ghost/ports");
    expect(r.status).toBe(404);
  });

  it("502s when kubectl get services fails", async () => {
    const deps = setup({
      k8s: {
        kubectl: async (args) => {
          if (args[0] === "get" && args[1] === "services") {
            return { code: 1, stdout: "", stderr: "unable to reach apiserver" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/ports");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("apiserver");
  });

  it("rejects an invalid check request (422) when port is missing", async () => {
    const deps = setup({
      k8s: {
        kubectl: async () => ({ code: 0, stdout: servicesJson, stderr: "" }),
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/ports/check?namespace=default&type=ClusterIP");
    expect(r.status).toBe(422);
  });
});
