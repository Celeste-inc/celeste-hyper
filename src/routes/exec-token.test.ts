import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";
import { signJwt } from "../lib/jwt.ts";
import { TEST_JWT_SECRET } from "./test-fakes.ts";

/** A k8s fake whose pods back the service with a known container. */
function k8sWithPod() {
  return {
    getWorkloadSelector: async () => "app=hello",
    listPods: async () => [{ name: "hello-abc", phase: "Running", containers: [{ name: "app", image: "i", ready: true, restartCount: 0 }] }],
  };
}

describe("POST /api/services/:name/exec/token", () => {
  it("mints a one-shot token bound to a pod/container that backs the service", async () => {
    const deps = makeFakeDeps({ k8s: k8sWithPod() });
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "POST", "/api/services/hello/exec/token", { pod: "hello-abc", container: "app" });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^[0-9a-f]{48}$/);
    // the token redeems exactly once to the bound (pod, container)
    expect(deps.state.redeemExecToken(r.body.token, "hello")).toEqual({ pod: "hello-abc", container: "app" });
    expect(deps.state.redeemExecToken(r.body.token, "hello")).toBeNull();
  });

  it("403 when the pod/container does not back the service", async () => {
    const deps = makeFakeDeps({ k8s: k8sWithPod() });
    seedCluster(deps);
    seedRegistryService(deps);
    const wrongPod = await call(buildApp(deps), "POST", "/api/services/hello/exec/token", { pod: "someone-elses-pod", container: "app" });
    expect(wrongPod.status).toBe(403);
    const wrongContainer = await call(buildApp(deps), "POST", "/api/services/hello/exec/token", { pod: "hello-abc", container: "sidecar" });
    expect(wrongContainer.status).toBe(403);
  });

  it("400 on a missing/invalid pod or container name", async () => {
    const deps = makeFakeDeps({ k8s: k8sWithPod() });
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    expect((await call(app, "POST", "/api/services/hello/exec/token", { container: "app" })).status).toBe(400);
    expect((await call(app, "POST", "/api/services/hello/exec/token", { pod: "--evil", container: "app" })).status).toBe(400);
  });

  it("404 for an unknown service", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/services/ghost/exec/token", { pod: "p", container: "c" });
    expect(r.status).toBe(404);
  });

  it("is operator-gated (a viewer is forbidden)", async () => {
    const deps = makeFakeDeps({ k8s: k8sWithPod() });
    seedCluster(deps);
    seedRegistryService(deps);
    const vt = await signJwt({ sub: "v", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    const r = await call(buildApp(deps), "POST", "/api/services/hello/exec/token", { pod: "hello-abc", container: "app" }, { auth: false, headers: { authorization: `Bearer ${vt}` } });
    expect(r.status).toBe(403);
  });
});
