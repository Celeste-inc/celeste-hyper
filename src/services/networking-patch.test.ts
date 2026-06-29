import { describe, it, expect } from "bun:test";
import { buildServicePortPatch, buildDeploymentContainerPortPatch } from "./networking-patch.ts";

describe("buildServicePortPatch", () => {
  it("emits a strategic merge patch keyed by the existing port name", () => {
    const patch = buildServicePortPatch({
      portName: "http",
      port: 8081,
      targetPort: 8081,
      protocol: "TCP",
      nodePort: 30890,
      type: "NodePort",
    });
    expect(patch.spec.type).toBe("NodePort");
    expect(patch.spec.ports).toHaveLength(1);
    expect(patch.spec.ports[0]).toEqual({
      name: "http",
      port: 8081,
      targetPort: 8081,
      protocol: "TCP",
      nodePort: 30890,
    });
  });

  it("omits nodePort when type is ClusterIP (kubectl rejects it otherwise)", () => {
    const patch = buildServicePortPatch({
      portName: "http",
      port: 80,
      targetPort: 80,
      protocol: "TCP",
      type: "ClusterIP",
    });
    expect(patch.spec.ports[0]!.nodePort).toBeUndefined();
  });

  it("preserves the port name so existing endpoints don't lose their identity (zero-downtime patch)", () => {
    const patch = buildServicePortPatch({ portName: "amqp", port: 5673, targetPort: 5673, protocol: "TCP", type: "ClusterIP" });
    expect(patch.spec.ports[0]!.name).toBe("amqp");
  });

  it("emits externalIPs when provided (escape hatch for ports outside the NodePort 30000-32767 range)", () => {
    const patch = buildServicePortPatch({
      portName: "http",
      port: 8090,
      targetPort: 80,
      protocol: "TCP",
      type: "ClusterIP",
      externalIPs: ["192.168.1.10"],
    });
    expect(patch.spec.externalIPs).toEqual(["192.168.1.10"]);
  });

  it("clears externalIPs by sending null when given an empty array (strategic-merge wipe)", () => {
    const patch = buildServicePortPatch({
      portName: "http",
      port: 80,
      targetPort: 80,
      protocol: "TCP",
      type: "ClusterIP",
      externalIPs: [],
    });
    expect(patch.spec.externalIPs).toBeNull();
  });

  it("omits externalIPs entirely when the field is not touched (preserves the stored list)", () => {
    const patch = buildServicePortPatch({ portName: "http", port: 80, targetPort: 80, protocol: "TCP", type: "ClusterIP" });
    expect("externalIPs" in patch.spec).toBe(false);
  });
});

describe("buildDeploymentContainerPortPatch", () => {
  it("patches the containerPort of the target container (strategic merge by name)", () => {
    const patch = buildDeploymentContainerPortPatch({
      containerName: "web",
      portName: "http",
      containerPort: 8081,
      protocol: "TCP",
    });
    expect(patch.spec.template.spec.containers).toEqual([
      { name: "web", ports: [{ name: "http", containerPort: 8081, protocol: "TCP" }] },
    ]);
  });
});
