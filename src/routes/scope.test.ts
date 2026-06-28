import { describe, it, expect } from "bun:test";
import { withinScope } from "./scope.ts";
import type { Principal } from "./auth.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { seedCluster, seedRegistryService } from "./test-helpers.ts";

function machine(over: Partial<Principal>): Principal {
  return { username: "machine:ci", role: "operator", csrf: null, source: "bearer", kind: "machine", ...over };
}

function setup() {
  const deps = makeFakeDeps();
  seedCluster(deps); // primary
  seedCluster(deps, { id: "edge", name: "Edge" });
  seedRegistryService(deps); // "hello" on primary
  seedRegistryService(deps, { name: "edge-svc", clusterId: "edge" });
  return deps;
}

describe("withinScope", () => {
  it("an unscoped token (and any user) is unrestricted", () => {
    const deps = setup();
    expect(withinScope(machine({}), "/api/clusters", deps)).toBe(true);
    expect(withinScope({ username: "alice", role: "admin", csrf: null, source: "cookie", kind: "user" }, "/api/clusters", deps)).toBe(true);
  });

  it("a service-scoped token is confined to its own service paths", () => {
    const deps = setup();
    const p = machine({ serviceScope: "hello" });
    expect(withinScope(p, "/api/services/hello/deploy", deps)).toBe(true);
    expect(withinScope(p, "/api/services/hello", deps)).toBe(true);
    expect(withinScope(p, "/api/services/edge-svc/deploy", deps)).toBe(false);
    expect(withinScope(p, "/api/clusters", deps)).toBe(false);
    expect(withinScope(p, "/api/system", deps)).toBe(false);
  });

  it("a service-scoped token can read its own deployment/job by id, not others'", () => {
    const deps = setup();
    const mine = deps.state.recordDeploymentStart("hello", "v1");
    const other = deps.state.recordDeploymentStart("edge-svc", "v1");
    deps.queue.enqueue({ id: mine, kind: "deploy", resourceKind: "service", resourceId: "hello", payload: { tag: "v1" } });
    const p = machine({ serviceScope: "hello" });
    expect(withinScope(p, `/api/deployments/${mine}`, deps)).toBe(true);
    expect(withinScope(p, `/api/jobs/${mine}`, deps)).toBe(true);
    expect(withinScope(p, `/api/deployments/${other}`, deps)).toBe(false);
    expect(withinScope(p, "/api/deployments/999999", deps)).toBe(false); // unknown id → deny
  });

  it("a cluster-scoped token may touch any service in its cluster and that cluster's endpoints", () => {
    const deps = setup();
    const p = machine({ clusterScope: "primary" });
    expect(withinScope(p, "/api/services/hello/deploy", deps)).toBe(true);
    expect(withinScope(p, "/api/services/edge-svc/deploy", deps)).toBe(false);
    expect(withinScope(p, "/api/clusters/primary/namespaces", deps)).toBe(true);
    expect(withinScope(p, "/api/clusters/edge/namespaces", deps)).toBe(false);
    expect(withinScope(p, "/api/system", deps)).toBe(false);
  });

  it("a service+cluster-scoped token requires both to match", () => {
    const deps = setup();
    const p = machine({ serviceScope: "hello", clusterScope: "edge" }); // hello is on primary, not edge
    expect(withinScope(p, "/api/services/hello/deploy", deps)).toBe(false);
    const ok = machine({ serviceScope: "hello", clusterScope: "primary" });
    expect(withinScope(ok, "/api/services/hello/deploy", deps)).toBe(true);
  });
});
