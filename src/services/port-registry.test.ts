import { describe, it, expect } from "bun:test";
import { aggregateClusterPorts, listClusterPortAllocations } from "./port-registry.ts";

const services = {
  items: [
    {
      metadata: { name: "alpha", namespace: "default" },
      spec: {
        type: "NodePort",
        clusterIP: "10.0.0.1",
        ports: [
          { name: "http", port: 80, targetPort: 8080, nodePort: 30080, protocol: "TCP" },
        ],
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
        ports: [
          { name: "api", port: 80, nodePort: 30081 },
          { name: "metrics", port: 9100, nodePort: 30090 },
        ],
      },
    },
  ],
};

describe("aggregateClusterPorts", () => {
  it("collects every NodePort across namespaces into one set", () => {
    const state = aggregateClusterPorts(services);
    expect([...state.nodePortsInUse].sort((a, b) => a - b)).toEqual([30080, 30081, 30090]);
  });

  it("collects service ports keyed by namespace", () => {
    const state = aggregateClusterPorts(services);
    expect([...state.servicePortsByNamespace.get("default")!].sort((a, b) => a - b)).toEqual([80, 6379]);
    expect([...state.servicePortsByNamespace.get("team-b")!].sort((a, b) => a - b)).toEqual([80, 9100]);
  });

  it("returns empty sets for an empty service list", () => {
    const state = aggregateClusterPorts({ items: [] });
    expect(state.nodePortsInUse.size).toBe(0);
    expect(state.servicePortsByNamespace.size).toBe(0);
  });

  it("tolerates a Service with no ports defined", () => {
    const state = aggregateClusterPorts({
      items: [{ metadata: { name: "headless", namespace: "default" }, spec: { ports: [] } }],
    });
    expect(state.servicePortsByNamespace.get("default")?.size ?? 0).toBe(0);
  });
});

describe("listClusterPortAllocations", () => {
  it("returns one row per (service, port) pair with owner metadata", () => {
    const rows = listClusterPortAllocations(services);
    const alphaHttp = rows.find((r) => r.service === "alpha");
    expect(alphaHttp).toMatchObject({
      service: "alpha",
      namespace: "default",
      type: "NodePort",
      port: 80,
      nodePort: 30080,
      protocol: "TCP",
      portName: "http",
    });
    expect(rows).toHaveLength(4); // alpha:80, beta:6379, gamma:80, gamma:9100
  });

  it("sorts rows by namespace then service then port for stable UI rendering", () => {
    const rows = listClusterPortAllocations(services);
    const keys = rows.map((r) => `${r.namespace}/${r.service}/${r.port}`);
    expect(keys).toEqual([...keys].sort());
  });
});
