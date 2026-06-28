import { describe, it, expect } from "bun:test";
import { aggregateNamespaces } from "./namespace-counts.ts";

const namespaces = [
  { name: "prod", phase: "Active", createdAt: "2026-01-01T00:00:00Z" },
  { name: "staging", phase: "Active", createdAt: "2026-02-01T00:00:00Z" },
  { name: "empty", phase: "Active", createdAt: "2026-03-01T00:00:00Z" },
];

describe("aggregateNamespaces", () => {
  it("computes per-namespace pod and workload counts", () => {
    const result = aggregateNamespaces(
      namespaces,
      ["prod", "prod", "prod", "staging"],
      [
        { kind: "Deployment", namespace: "prod" },
        { kind: "Deployment", namespace: "prod" },
        { kind: "StatefulSet", namespace: "prod" },
        { kind: "DaemonSet", namespace: "staging" },
      ],
    );
    const prod = result.find((n) => n.name === "prod")!;
    expect(prod).toMatchObject({ podCount: 3, deploymentCount: 2, statefulsetCount: 1, daemonsetCount: 0 });
    const staging = result.find((n) => n.name === "staging")!;
    expect(staging).toMatchObject({ podCount: 1, daemonsetCount: 1, deploymentCount: 0 });
  });

  it("reports zeros for empty namespaces and keeps phase/createdAt", () => {
    const result = aggregateNamespaces(namespaces, [], []);
    const empty = result.find((n) => n.name === "empty")!;
    expect(empty).toEqual({
      name: "empty",
      phase: "Active",
      createdAt: "2026-03-01T00:00:00Z",
      deploymentCount: 0,
      statefulsetCount: 0,
      daemonsetCount: 0,
      podCount: 0,
    });
  });

  it("ignores pods/workloads in namespaces not in the list, and sorts by name", () => {
    const result = aggregateNamespaces(namespaces, ["ghost", "prod"], [{ kind: "Deployment", namespace: "ghost" }]);
    expect(result.map((n) => n.name)).toEqual(["empty", "prod", "staging"]);
    expect(result.find((n) => n.name === "prod")!.podCount).toBe(1);
  });
});
