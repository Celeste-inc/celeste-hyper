import { describe, it, expect } from "bun:test";
import { State } from "../../lib/state.ts";
import { Registry } from "../../services/registry.ts";
import { fakeClock } from "../../lib/clock.ts";
import type { RunResult } from "../../lib/k8s.ts";
import type { K8sPool } from "../../services/k8s-pool.ts";
import type { HelmLike } from "../../lib/helm.ts";
import { Queue } from "../queue.ts";
import { makeHelmUpgradeHandler, HELM_UPGRADE_JOB_KIND } from "./helm-upgrade.ts";

const OK: RunResult = { code: 0, stdout: "", stderr: "" };

function fakeK8s(podImage: string) {
  return {
    getWorkloadJson: async (): Promise<RunResult> => ({ code: 0, stdout: JSON.stringify({ metadata: { annotations: { "meta.helm.sh/release-name": "api", "meta.helm.sh/release-namespace": "prod" } } }), stderr: "" }),
    kubectl: async (args: string[]): Promise<RunResult> => (args.includes("get") ? { code: 0, stdout: podImage, stderr: "" } : OK),
  };
}
function fakePool(k8s: unknown): K8sPool {
  return { get: () => k8s, getOrThrow: () => k8s } as unknown as K8sPool;
}

function setup(podImage: string, helm: HelmLike) {
  const clock = fakeClock(0);
  const state = new State(":memory:", clock);
  const registry = new Registry(state);
  registry.create({
    sourceType: "registry-pull",
    name: "api",
    namespace: "default",
    clusterId: "primary",
    imageRef: "bitnami/nginx",
    workloadKind: "Deployment",
    enabled: true,
    helmRelease: "api",
    helmChartRef: "bitnami/nginx",
    helmImageTagValuePath: "image.tag",
  } as never);
  const pool = fakePool(fakeK8s(podImage));
  const queue = new Queue(state, clock);
  const handler = makeHelmUpgradeHandler({ state, registry, helm, pool });
  return { clock, state, registry, queue, handler };
}

async function runJob(deps: ReturnType<typeof setup>, tag: string) {
  const id = deps.state.recordDeploymentStart("api", tag);
  deps.queue.enqueue({ id, kind: HELM_UPGRADE_JOB_KIND, resourceKind: "service", resourceId: "api", payload: { tag } });
  const job = deps.queue.claim("w1")!;
  deps.queue.setFencingToken(job.id, 5);
  job.fencing_token = 5;
  return { id, run: deps.handler(job) };
}

describe("helm-upgrade handler", () => {
  it("runs helm upgrade with the configured value path and verifies the tag took effect", async () => {
    let seenArgs: string[] = [];
    const helm: HelmLike = { run: async (_c, args) => ((seenArgs = args), OK) };
    const deps = setup("bitnami/nginx:v2.0.0", helm); // pod now reports the new tag
    const { id, run } = await runJob(deps, "v2.0.0");
    await run;
    expect(seenArgs).toEqual(["upgrade", "api", "bitnami/nginx", "-n", "prod", "--reuse-values", "--set", "image.tag=v2.0.0", "--wait", "--timeout", "180s"]);
    expect(deps.state.getCurrent("api")!.tag).toBe("v2.0.0");
    expect(deps.state.deploymentById(id)!.status).toBe("done");
  });

  it("fails with helm-upgrade-did-not-take-effect when the pod tag does not match (wrong value path)", async () => {
    const helm: HelmLike = { run: async () => OK }; // helm "succeeds"...
    const deps = setup("bitnami/nginx:v1-old", helm); // ...but the pod still runs the old tag
    const { run } = await runJob(deps, "v2.0.0");
    await expect(run).rejects.toThrow("helm-upgrade-did-not-take-effect");
    expect(deps.state.getCurrent("api")).toBeNull(); // not promoted
  });

  it("throws the helm stderr when the upgrade itself fails", async () => {
    const helm: HelmLike = { run: async () => ({ code: 1, stdout: "", stderr: "Error: UPGRADE FAILED: timed out" }) };
    const deps = setup("bitnami/nginx:v1", helm);
    const { run } = await runJob(deps, "v2.0.0");
    await expect(run).rejects.toThrow("UPGRADE FAILED");
  });

  it("throws when the service is not configured for helm", async () => {
    const helm: HelmLike = { run: async () => OK };
    const deps = setup("x", helm);
    deps.registry.update("api", { helmImageTagValuePath: undefined } as never);
    const { run } = await runJob(deps, "v2");
    await expect(run).rejects.toThrow("not configured for helm upgrade");
  });
});
