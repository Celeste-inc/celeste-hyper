import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  seedRegistryService(deps, { name: "api", containerName: "api" });
  return deps;
}

describe("DELETE /api/services/:name/pods/:pod", () => {
  it("deletes the pod via kubectl when it belongs to the service", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        getWorkloadSelector: async () => "app=api",
        listPods: async () => [{ name: "api-abc", containers: [{ name: "api" }] }],
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "DELETE", "/api/services/api/pods/api-abc");
    expect(r.status).toBe(200);
    const del = calls.find((a) => a.includes("delete") && a.includes("pod"));
    expect(del).toBeDefined();
    expect(del).toContain("api-abc");
    expect(del).toContain("--grace-period=0"); // snappy apiserver removal; kubelet honours pod's terminationGracePeriodSeconds
    expect(del).toContain("--wait=false");
    expect(del).not.toContain("--force"); // only when ?force=true
  });

  it("?force=true adds --force for evicting a pod stuck in Terminating", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        getWorkloadSelector: async () => "app=api",
        listPods: async () => [{ name: "api-abc", containers: [{ name: "api" }] }],
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "DELETE", "/api/services/api/pods/api-abc?force=true");
    expect(r.status).toBe(200);
    expect(r.body.forced).toBe(true);
    const del = calls.find((a) => a.includes("delete") && a.includes("pod"));
    expect(del).toContain("--force");
  });

  it("403 when the pod doesn't back this service (anti-cross-tenant)", async () => {
    const deps = setup({
      k8s: {
        getWorkloadSelector: async () => "app=api",
        listPods: async () => [{ name: "api-abc", containers: [{ name: "api" }] }],
        kubectl: async () => ({ code: 0, stdout: "", stderr: "" }),
      } as never,
    });
    const r = await call(buildApp(deps), "DELETE", "/api/services/api/pods/other-xyz");
    expect(r.status).toBe(403);
  });

  it("400 on a pod name that violates RFC-1123 (flag-injection guard)", async () => {
    const deps = setup();
    const r = await call(buildApp(deps), "DELETE", "/api/services/api/pods/-evil");
    expect(r.status).toBe(400);
  });

  it("404 when the service is unknown", async () => {
    const deps = setup();
    const r = await call(buildApp(deps), "DELETE", "/api/services/ghost/pods/api-abc");
    expect(r.status).toBe(404);
  });

  it("a viewer cannot delete a pod (operator+)", async () => {
    const { signJwt } = await import("../lib/jwt.ts");
    const { TEST_JWT_SECRET } = await import("./test-fakes.ts");
    const token = await signJwt({ sub: "u-viewer", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    const deps = setup();
    const r = await call(buildApp(deps), "DELETE", "/api/services/api/pods/api-abc", undefined, {
      auth: false,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
  });
});

describe("POST /api/services/:name/redeploy", () => {
  it("triggers a rollout restart of the workload (no image change)", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "POST", "/api/services/api/redeploy", {});
    expect(r.status).toBe(200);
    const restart = calls.find((a) => a.includes("rollout") && a.includes("restart"));
    expect(restart).toBeDefined();
    expect(restart).toContain("deployment/api");
  });

  it("records a deployment row so the live stream and history pick it up", async () => {
    const deps = setup({
      k8s: {
        kubectl: async () => ({ code: 0, stdout: "", stderr: "" }),
      } as never,
    });
    // Pretend a previous successful deploy set the current tag.
    deps.state.setCurrent("api", "v9");
    const r = await call(buildApp(deps), "POST", "/api/services/api/redeploy", {});
    expect(r.status).toBe(200);
    expect(r.body.deploymentId).toBeGreaterThan(0);
    const recorded = deps.state.deploymentById(r.body.deploymentId);
    expect(recorded?.tag).toBe("v9");
  });

  it("uses 'redeployed' as the current tag when none was recorded yet", async () => {
    const deps = setup({
      k8s: { kubectl: async () => ({ code: 0, stdout: "", stderr: "" }) } as never,
    });
    const r = await call(buildApp(deps), "POST", "/api/services/api/redeploy", {});
    expect(r.status).toBe(200);
    const recorded = deps.state.deploymentById(r.body.deploymentId);
    expect(recorded?.tag).toBe("redeployed");
  });

  it("502 when kubectl rollout restart fails", async () => {
    const deps = setup({
      k8s: { kubectl: async () => ({ code: 1, stdout: "", stderr: "Forbidden" }) } as never,
    });
    const r = await call(buildApp(deps), "POST", "/api/services/api/redeploy", {});
    expect(r.status).toBe(502);
  });

  it("404 when the service is unknown", async () => {
    const deps = setup();
    const r = await call(buildApp(deps), "POST", "/api/services/ghost/redeploy", {});
    expect(r.status).toBe(404);
  });
});
