import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";

const servicesJson = JSON.stringify({
  items: [
    {
      metadata: { name: "existing", namespace: "default" },
      spec: { type: "NodePort", ports: [{ port: 80, nodePort: 30080, protocol: "TCP" }] },
    },
  ],
});

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  return deps;
}

describe("service create — port conflict resolution", () => {
  it("auto-reassigns a conflicting expose.port and surfaces the reassignment in the response", async () => {
    const deps = setup({
      k8s: {
        kubectl: async (args) => {
          if (args[0] === "get" && args[1] === "services") return { code: 0, stdout: servicesJson, stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "POST", "/api/services", {
      sourceType: "registry-pull",
      name: "newcomer",
      namespace: "default",
      clusterId: "primary",
      imageRef: "traefik/whoami",
      workloadKind: "Deployment",
      expose: { type: "NodePort", port: 80, nodePort: 30080, protocol: "TCP" },
    });
    expect(r.status).toBe(201);
    expect(r.body.service.expose.port).not.toBe(80);
    expect(r.body.service.expose.nodePort).not.toBe(30080);
    expect(r.body.portReassignments).toBeDefined();
    expect(r.body.portReassignments.length).toBeGreaterThan(0);
    const kinds = r.body.portReassignments.map((c: { kind: string }) => c.kind).sort();
    expect(kinds).toEqual(["node-port", "service-port"]);
  });

  it("leaves the expose untouched and reports zero reassignments when no conflict exists", async () => {
    const deps = setup({
      k8s: {
        kubectl: async (args) => {
          if (args[0] === "get" && args[1] === "services") return { code: 0, stdout: servicesJson, stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "POST", "/api/services", {
      sourceType: "registry-pull",
      name: "freebird",
      namespace: "default",
      clusterId: "primary",
      imageRef: "traefik/whoami",
      workloadKind: "Deployment",
      expose: { type: "ClusterIP", port: 9090, protocol: "TCP" },
    });
    expect(r.status).toBe(201);
    expect(r.body.service.expose.port).toBe(9090);
    expect(r.body.portReassignments).toEqual([]);
  });

  it("is a no-op for services without an expose block (port manager only runs when expose is set)", async () => {
    let kubectlCalls = 0;
    const deps = setup({
      k8s: {
        kubectl: async (args) => {
          kubectlCalls++;
          if (args[0] === "get" && args[1] === "services") return { code: 0, stdout: servicesJson, stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "POST", "/api/services", {
      sourceType: "registry-pull",
      name: "minimal",
      namespace: "default",
      clusterId: "primary",
      imageRef: "traefik/whoami",
      workloadKind: "Deployment",
    });
    expect(r.status).toBe(201);
    expect(r.body.portReassignments).toBeUndefined();
    expect(kubectlCalls).toBe(0); // skipped the cluster fetch entirely
  });
});
