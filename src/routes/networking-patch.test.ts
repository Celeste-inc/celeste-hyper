import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  seedRegistryService(deps, { name: "rmq", containerName: "rmq" });
  return deps;
}

describe("PATCH /api/services/:name/networking", () => {
  it("patches the Service port and the Deployment's containerPort atomically", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        getServiceInfo: async () => ({
          name: "rmq",
          namespace: "default",
          type: "ClusterIP",
          clusterIP: "10.0.0.1",
          clusterIPs: ["10.0.0.1"],
          externalIPs: [],
          ports: [{ name: "amqp", port: 5672, targetPort: 5672, nodePort: null, protocol: "TCP" }],
        }),
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });

    const r = await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", {
      portName: "amqp",
      port: 5673,
      targetPort: 5673,
    });
    expect(r.status).toBe(200);

    const svcPatch = calls.find((a) => a.includes("patch") && a.includes("service"));
    const deployPatch = calls.find((a) => a.includes("patch") && a.includes("deployment"));
    expect(svcPatch).toBeDefined();
    expect(deployPatch).toBeDefined();

    const svcBody = JSON.parse(svcPatch![svcPatch!.indexOf("-p") + 1]!) as { spec: { ports: Array<{ port: number; name: string }> } };
    expect(svcBody.spec.ports[0]).toMatchObject({ name: "amqp", port: 5673 });
    const depBody = JSON.parse(deployPatch![deployPatch!.indexOf("-p") + 1]!) as { spec: { template: { spec: { containers: Array<{ ports: Array<{ containerPort: number }> }> } } } };
    expect(depBody.spec.template.spec.containers[0]!.ports[0]!.containerPort).toBe(5673);
  });

  it("can change the Service type to NodePort and exposes a nodePort", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        getServiceInfo: async () => ({
          name: "rmq",
          namespace: "default",
          type: "ClusterIP",
          clusterIP: "10.0.0.1",
          clusterIPs: ["10.0.0.1"],
          externalIPs: [],
          ports: [{ name: "amqp", port: 5672, targetPort: 5672, nodePort: null, protocol: "TCP" }],
        }),
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });

    const r = await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", {
      type: "NodePort",
      nodePort: 30890,
    });
    expect(r.status).toBe(200);
    const svcPatch = calls.find((a) => a.includes("patch") && a.includes("service"));
    const body = JSON.parse(svcPatch![svcPatch!.indexOf("-p") + 1]!) as { spec: { type: string; ports: Array<{ nodePort?: number }> } };
    expect(body.spec.type).toBe("NodePort");
    expect(body.spec.ports[0]!.nodePort).toBe(30890);
  });

  it("404 when there's no Service object to patch", async () => {
    const deps = setup({
      k8s: { getServiceInfo: async () => null } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", { port: 5673 });
    expect(r.status).toBe(404);
  });

  it("422 with a helpful hint when nodePort is outside the k8s default range (30000-32767)", async () => {
    const deps = setup({
      k8s: {
        getServiceInfo: async () => ({
          name: "rmq",
          namespace: "default",
          type: "ClusterIP",
          clusterIP: "10.0.0.1",
          clusterIPs: ["10.0.0.1"],
          externalIPs: [],
          ports: [{ name: "amqp", port: 5672, targetPort: 5672, nodePort: null, protocol: "TCP" }],
        }),
      } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", {
      type: "NodePort",
      nodePort: 8090,
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("30000-32767");
    expect(r.body.hint).toMatch(/externalIPs|LoadBalancer/);
  });

  it("accepts externalIPs to expose the port on host IPs without the NodePort range constraint", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        getServiceInfo: async () => ({
          name: "rmq",
          namespace: "default",
          type: "ClusterIP",
          clusterIP: "10.0.0.1",
          clusterIPs: ["10.0.0.1"],
          externalIPs: [],
          ports: [{ name: "amqp", port: 5672, targetPort: 5672, nodePort: null, protocol: "TCP" }],
        }),
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", {
      port: 8090,
      externalIPs: ["192.168.1.10"],
    });
    expect(r.status).toBe(200);
    const svcPatch = calls.find((a) => a.includes("patch") && a.includes("service"));
    const body = JSON.parse(svcPatch![svcPatch!.indexOf("-p") + 1]!) as { spec: { externalIPs: string[]; ports: Array<{ port: number }> } };
    expect(body.spec.externalIPs).toEqual(["192.168.1.10"]);
    expect(body.spec.ports[0]!.port).toBe(8090);
  });

  it("clears externalIPs when an empty array is sent", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        getServiceInfo: async () => ({
          name: "rmq",
          namespace: "default",
          type: "ClusterIP",
          clusterIP: "10.0.0.1",
          clusterIPs: ["10.0.0.1"],
          externalIPs: ["10.0.0.1"],
          ports: [{ name: "amqp", port: 5672, targetPort: 5672, nodePort: null, protocol: "TCP" }],
        }),
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", {
      externalIPs: [],
    });
    expect(r.status).toBe(200);
    const svcPatch = calls.find((a) => a.includes("patch") && a.includes("service"));
    const body = JSON.parse(svcPatch![svcPatch!.indexOf("-p") + 1]!) as { spec: { externalIPs: null } };
    expect(body.spec.externalIPs).toBeNull();
  });

  it("422 when port is out of range", async () => {
    const deps = setup({
      k8s: {
        getServiceInfo: async () => ({
          name: "rmq",
          namespace: "default",
          type: "ClusterIP",
          clusterIP: "10.0.0.1",
          clusterIPs: ["10.0.0.1"],
          externalIPs: [],
          ports: [{ name: "amqp", port: 5672, targetPort: 5672, nodePort: null, protocol: "TCP" }],
        }),
      } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", { port: 99999 });
    expect(r.status).toBe(422);
  });

  it("does NOT recreate the workload (no `kubectl delete` or `apply -f -`), so data is preserved", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        getServiceInfo: async () => ({
          name: "rmq",
          namespace: "default",
          type: "ClusterIP",
          clusterIP: "10.0.0.1",
          clusterIPs: ["10.0.0.1"],
          externalIPs: [],
          ports: [{ name: "amqp", port: 5672, targetPort: 5672, nodePort: null, protocol: "TCP" }],
        }),
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", { port: 5673, targetPort: 5673 });
    const destructive = calls.some((a) => a.includes("delete") || (a.includes("apply") && a.includes("-f")));
    expect(destructive).toBe(false);
  });

  it("a viewer cannot PATCH (operator+)", async () => {
    const { signJwt } = await import("../lib/jwt.ts");
    const { TEST_JWT_SECRET } = await import("./test-fakes.ts");
    const token = await signJwt({ sub: "u-viewer", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    const deps = setup();
    const r = await call(buildApp(deps), "PATCH", "/api/services/rmq/networking", { port: 5673 }, {
      auth: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(r.status).toBe(403);
  });
});
