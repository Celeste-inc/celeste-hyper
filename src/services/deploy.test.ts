import { describe, it, expect } from "bun:test";
import { State } from "../lib/state.ts";
import { fakeClock, type FakeClock } from "../lib/clock.ts";
import { Deployer } from "./deploy.ts";
import type { RegistryPullService } from "./model.ts";

const OK = { code: 0, stdout: "", stderr: "" };
const baseDeployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "shop", uid: "u", resourceVersion: "1", labels: { app: "web" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: "web" } },
    template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "img:old" }] } },
  },
  status: { readyReplicas: 2 },
};

function svc(over: Partial<RegistryPullService> = {}): RegistryPullService {
  return {
    sourceType: "registry-pull",
    name: "web",
    namespace: "shop",
    clusterId: "c1",
    imageRef: "img",
    workloadKind: "Deployment",
    enabled: true,
    deployMode: "rolling",
    ...over,
  } as RegistryPullService;
}

type Calls = Record<string, unknown[][]>;
function fakeK8s(over: Record<string, unknown> = {}) {
  const calls: Calls = {};
  const rec = (n: string, fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
    (calls[n] ??= []).push(a);
    return fn(...a);
  };
  const k8s = {
    runtime: "docker",
    setImage: rec("setImage", async () => OK),
    rolloutStatus: rec("rolloutStatus", async () => OK),
    patchWorkloadStrategy: rec("patchWorkloadStrategy", async () => OK),
    getWorkloadJson: rec("getWorkloadJson", async () => ({ code: 0, stdout: JSON.stringify(baseDeployment), stderr: "" })),
    applyManifest: rec("applyManifest", async () => OK),
    getReadyReplicas: rec("getReadyReplicas", async () => 1),
    deleteWorkload: rec("deleteWorkload", async () => OK),
    getServiceInfo: rec("getServiceInfo", async () => ({ name: "web-svc", namespace: "shop", ports: [] })),
    patchServiceSelector: rec("patchServiceSelector", async () => OK),
    scaleWorkload: rec("scaleWorkload", async () => OK),
    getWorkloadSelector: rec("getWorkloadSelector", async () => "app=web"),
    listPods: rec("listPods", async () => [{ phase: "Running", containers: [{ name: "web", image: "img:new", ready: true, restartCount: 0 }] }]),
    ...over,
  };
  return { k8s, calls };
}

function makeDeployer(state: State, clock: FakeClock, k8s: unknown) {
  const pool = { getOrThrow: () => k8s, get: () => k8s } as never;
  return new Deployer({ workDir: "/tmp" } as never, {} as never, pool, state, clock);
}

/** Drive a pending promise to settle while repeatedly advancing the fake clock past any delays. */
async function settle<T>(clock: FakeClock, p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 100 && !done; i++) {
    await Promise.resolve();
    clock.advance(5000);
    await Promise.resolve();
  }
  return p;
}

function setup() {
  const clock = fakeClock(0);
  const state = new State(":memory:", clock);
  return { clock, state };
}

describe("Deployer deploy modes", () => {
  it("rolling: set image then rollout, set current", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s();
    const id = state.recordDeploymentStart("web", "v1");
    const res = await makeDeployer(state, clock, k8s).deployExisting({ service: svc(), tag: "v1" }, id);
    expect(res.ok).toBe(true);
    expect(calls.setImage).toHaveLength(1);
    expect(calls.rolloutStatus).toHaveLength(1);
    expect(state.getCurrent("web")!.tag).toBe("v1");
  });

  it("recreate: patches strategy to Recreate before applying", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s();
    const id = state.recordDeploymentStart("web", "v1");
    const res = await makeDeployer(state, clock, k8s).deployExisting({ service: svc({ deployMode: "recreate" }), tag: "v1" }, id);
    expect(res.ok).toBe(true);
    expect(calls.patchWorkloadStrategy![0]![3]).toBe("Recreate");
    expect(calls.setImage).toHaveLength(1);
  });

  it("canary: creates a temp deployment, promotes after the success threshold, tears it down", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s({ getReadyReplicas: async () => 1 });
    const id = state.recordDeploymentStart("web", "v1");
    const res = await settle(
      clock,
      makeDeployer(state, clock, k8s).deployExisting(
        { service: svc({ deployMode: "canary", canaryConfig: { replicas: 1, observationSec: 3, successThreshold: 3 } }), tag: "v1" },
        id,
      ),
    );
    expect(res.ok).toBe(true);
    expect(calls.applyManifest).toHaveLength(1); // canary created
    const canary = JSON.parse((calls.applyManifest![0]![0] as string)) as { metadata: { name: string } };
    expect(canary.metadata.name).toBe("web-canary");
    expect(calls.setImage).toHaveLength(1); // promotion to main
    expect(calls.deleteWorkload).toHaveLength(1); // teardown
    expect(state.getCurrent("web")!.tag).toBe("v1");
  });

  it("canary: aborts and tears down when the canary never becomes ready", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s({ getReadyReplicas: async () => 0 });
    const id = state.recordDeploymentStart("web", "v1");
    const res = await settle(
      clock,
      makeDeployer(state, clock, k8s).deployExisting(
        { service: svc({ deployMode: "canary", canaryConfig: { replicas: 1, observationSec: 3, successThreshold: 3 } }), tag: "v1" },
        id,
      ),
    );
    expect(res.ok).toBe(false);
    expect(calls.setImage).toBeUndefined(); // never promoted
    expect(calls.deleteWorkload).toHaveLength(1); // still torn down
  });

  it("blue-green: creates green, flips the Service selector, drains blue", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s();
    const id = state.recordDeploymentStart("web", "v1");
    const res = await settle(
      clock,
      makeDeployer(state, clock, k8s).deployExisting({ service: svc({ deployMode: "blue-green" }), tag: "v1" }, id),
    );
    expect(res.ok).toBe(true);
    const green = JSON.parse((calls.applyManifest![0]![0] as string)) as { metadata: { name: string } };
    expect(green.metadata.name).toBe("web-green");
    expect(calls.patchServiceSelector).toHaveLength(1); // flip
    expect(calls.scaleWorkload![0]![3]).toBe(0); // drain blue to 0
    expect(state.getCurrent("web")!.tag).toBe("v1");
  });

  it("health gate: passes when pods are ready, records the result, promotes current", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s(); // getWorkloadJson → readyReplicas 2 == replicas 2; pods Running, 0 restarts
    const id = state.recordDeploymentStart("web", "v1");
    const res = await settle(
      clock,
      makeDeployer(state, clock, k8s).deployExisting(
        { service: svc({ healthGate: { attempts: 6, intervalSec: 5, successThreshold: 2 } }), tag: "v1" },
        id,
      ),
    );
    expect(res.ok).toBe(true);
    expect(calls.listPods).toBeDefined(); // gate sampled pods
    const gate = JSON.parse(state.deploymentById(id)!.health_gate_result!) as { ok: boolean };
    expect(gate.ok).toBe(true);
    expect(state.getCurrent("web")!.tag).toBe("v1");
  });

  it("health gate: fails on CrashLoopBackOff → deploy fails, current not promoted", async () => {
    const { clock, state } = setup();
    const { k8s } = fakeK8s({
      listPods: async () => [{ phase: "Running", containers: [{ name: "web", image: "img:new", ready: false, restartCount: 4, waitingReason: "CrashLoopBackOff" }] }],
    });
    const id = state.recordDeploymentStart("web", "v1");
    const res = await settle(
      clock,
      makeDeployer(state, clock, k8s).deployExisting(
        { service: svc({ healthGate: { attempts: 6, intervalSec: 5, successThreshold: 2 } }), tag: "v1" },
        id,
      ),
    );
    expect(res.ok).toBe(false);
    expect(state.getCurrent("web")).toBeNull(); // gate failed → not promoted
    const gate = JSON.parse(state.deploymentById(id)!.health_gate_result!) as { ok: boolean; lastReason: string };
    expect(gate.ok).toBe(false);
    expect(gate.lastReason).toBe("CrashLoopBackOff");
  });

  it("health gate is skipped when service.healthGate is unset (opt-out)", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s();
    const id = state.recordDeploymentStart("web", "v1");
    const res = await makeDeployer(state, clock, k8s).deployExisting({ service: svc(), tag: "v1" }, id);
    expect(res.ok).toBe(true);
    expect(calls.listPods).toBeUndefined(); // no gate → no pod sampling
    expect(state.deploymentById(id)!.health_gate_result).toBeNull();
  });

  it("blue-green: a failing health gate tears down green and does not flip", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s({
      listPods: async () => [{ phase: "Running", containers: [{ name: "web", image: "img:new", ready: false, restartCount: 0, waitingReason: "ImagePullBackOff" }] }],
    });
    const id = state.recordDeploymentStart("web", "v1");
    const res = await settle(
      clock,
      makeDeployer(state, clock, k8s).deployExisting(
        { service: svc({ deployMode: "blue-green", healthGate: { attempts: 4, intervalSec: 5, successThreshold: 2 } }), tag: "v1" },
        id,
      ),
    );
    expect(res.ok).toBe(false);
    expect(calls.patchServiceSelector).toBeUndefined(); // never flipped to an unhealthy green
    expect(calls.deleteWorkload).toHaveLength(1); // green torn down
    expect(state.getCurrent("web")).toBeNull();
  });

  it("blue-green: refused on a StatefulSet workload", async () => {
    const { clock, state } = setup();
    const { k8s, calls } = fakeK8s();
    const id = state.recordDeploymentStart("db", "v1");
    const res = await makeDeployer(state, clock, k8s).deployExisting(
      { service: svc({ name: "db", deployMode: "blue-green", workloadKind: "StatefulSet" }), tag: "v1" },
      id,
    );
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.message).toContain("requires a Deployment");
    expect(calls.applyManifest).toBeUndefined();
  });
});
