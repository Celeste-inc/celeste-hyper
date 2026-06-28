import { describe, it, expect } from "bun:test";
import { State } from "../../lib/state.ts";
import { Registry } from "../../services/registry.ts";
import { fakeClock } from "../../lib/clock.ts";
import type { RunResult } from "../../lib/k8s.ts";
import type { K8sPool } from "../../services/k8s-pool.ts";
import { Queue } from "../queue.ts";
import { Worker } from "../worker.ts";
import { resolveRollbackTarget, makeRollbackHandler, ROLLBACK_JOB_KIND, imageTag } from "./rollback.ts";

const OK: RunResult = { code: 0, stdout: "", stderr: "" };
const HISTORY = "deployment.apps/demo\nREVISION  CHANGE-CAUSE\n1  <none>\n2  <none>\n3  <none>\n";

type KubectlFn = (args: string[]) => RunResult;

function fakeK8s(kubectl: KubectlFn) {
  return { kubectl: async (a: string[]) => kubectl(a), rolloutStatus: async () => OK };
}
function fakePool(k8s: unknown): K8sPool {
  return { get: () => k8s, getOrThrow: () => k8s } as unknown as K8sPool;
}

/** Dispatch a fake kubectl by the verbs in its args. */
function kubectlRouter(routes: { history?: RunResult; undo?: RunResult; image?: string }): KubectlFn {
  return (args) => {
    if (args.includes("history")) return routes.history ?? { code: 1, stdout: "", stderr: "no history" };
    if (args.includes("undo")) return routes.undo ?? OK;
    if (args.includes("get")) return { code: 0, stdout: routes.image ?? "", stderr: "" };
    return OK;
  };
}

function setup(kubectl: KubectlFn) {
  const clock = fakeClock(1000);
  const state = new State(":memory:", clock);
  const registry = new Registry(state);
  registry.create({
    sourceType: "registry-pull",
    name: "demo",
    namespace: "default",
    clusterId: "primary",
    imageRef: "traefik/whoami",
    workloadKind: "Deployment",
    enabled: true,
  } as never);
  const pool = fakePool(fakeK8s(kubectl));
  const queue = new Queue(state, clock);
  return { clock, state, registry, pool, queue };
}

describe("imageTag", () => {
  it("parses a plain repo:tag", () => expect(imageTag("traefik/whoami:v1.10")).toBe("v1.10"));
  it("ignores a registry port", () => expect(imageTag("registry:5000/img:v2")).toBe("v2"));
  it("returns null for a registry port with no tag", () => expect(imageTag("registry:5000/img")).toBeNull());
  it("returns null for a digest pin", () => expect(imageTag("img@sha256:abcdef")).toBeNull());
  it("returns null for empty", () => expect(imageTag("")).toBeNull());
});

describe("resolveRollbackTarget", () => {
  it("prefers hyper history (Source A): the previous done tag", async () => {
    const { state, registry, pool } = setup(kubectlRouter({}));
    const svc = registry.get("demo")!;
    state.updateDeployment(state.recordDeploymentStart("demo", "v1"), "done");
    state.updateDeployment(state.recordDeploymentStart("demo", "v2"), "done");
    const target = await resolveRollbackTarget({ state, pool }, svc, "v2");
    expect(target).toEqual({ previousTag: "v1", previousRevision: null, source: "hyper" });
  });

  it("falls back to cluster history (Source B) when hyper has none", async () => {
    const { state, registry, pool } = setup(kubectlRouter({ history: { code: 0, stdout: HISTORY, stderr: "" } }));
    const svc = registry.get("demo")!;
    const target = await resolveRollbackTarget({ state, pool }, svc, "v9");
    expect(target).toEqual({ previousTag: null, previousRevision: 2, source: "cluster" });
  });

  it("returns source null when neither has a previous", async () => {
    const { state, registry, pool } = setup(kubectlRouter({ history: { code: 1, stdout: "", stderr: "x" } }));
    const svc = registry.get("demo")!;
    const target = await resolveRollbackTarget({ state, pool }, svc, "v1");
    expect(target.source).toBeNull();
  });
});

describe("makeRollbackHandler", () => {
  async function runJob(deps: ReturnType<typeof setup>, payload: object) {
    const handler = makeRollbackHandler({ state: deps.state, registry: deps.registry, pool: deps.pool });
    const id = deps.state.recordDeploymentStart("demo", "x", "rollback");
    deps.queue.enqueue({ id, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "demo", payload });
    const job = deps.queue.claim("w1")!;
    deps.queue.setFencingToken(job.id, 5);
    job.fencing_token = 5;
    await handler(job);
    return id;
  }

  it("sets current to the expected tag when the pod image confirms it, action=rollback", async () => {
    const deps = setup(kubectlRouter({ undo: OK, image: "traefik/whoami:v1" }));
    const id = await runJob(deps, { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1" });
    expect(deps.state.getCurrent("demo")!.tag).toBe("v1");
    const row = deps.state.deploymentById(id)!;
    expect(row.action).toBe("rollback");
    expect(row.status).toBe("done");
    expect(row.message).toContain("rollback to v1");
  });

  it("uses rollback-rev-N + a warning when the pod image does not match the expected tag", async () => {
    const deps = setup(kubectlRouter({ undo: OK, image: "traefik/whoami:UNEXPECTED" }));
    const id = await runJob(deps, { previousTag: "v1", previousRevision: 2, source: "hyper", expectedTag: "v1" });
    expect(deps.state.getCurrent("demo")!.tag).toBe("rollback-rev-2");
    expect(deps.state.deploymentById(id)!.message).toContain("!= expected 'v1'");
  });

  it("Source A mismatch with an unreadable pod image falls back to rollback-rev-unknown", async () => {
    const deps = setup(kubectlRouter({ undo: OK, image: "" })); // image read yields no tag
    const id = await runJob(deps, { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1" });
    expect(deps.state.getCurrent("demo")!.tag).toBe("rollback-rev-unknown");
    expect(deps.state.deploymentById(id)!.message).toContain("!= expected 'v1'");
  });

  it("throws (→ job failure) when kubectl undo fails", async () => {
    const deps = setup(kubectlRouter({ undo: { code: 1, stdout: "", stderr: "Error from server" } }));
    const handler = makeRollbackHandler({ state: deps.state, registry: deps.registry, pool: deps.pool });
    const id = deps.state.recordDeploymentStart("demo", "x", "rollback");
    deps.queue.enqueue({ id, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "demo", payload: { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1" } });
    const job = deps.queue.claim("w1")!;
    await expect(handler(job)).rejects.toThrow("Error from server");
  });

  it("honors fencing — a stale token cannot overwrite a newer current_deployment", async () => {
    const deps = setup(kubectlRouter({ undo: OK, image: "traefik/whoami:v1" }));
    deps.state.setCurrentFenced("demo", "v9-newer", 10); // a newer deploy already committed at token 10
    const handler = makeRollbackHandler({ state: deps.state, registry: deps.registry, pool: deps.pool });
    const id = deps.state.recordDeploymentStart("demo", "v1", "rollback");
    deps.queue.enqueue({ id, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "demo", payload: { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1" } });
    const job = deps.queue.claim("w1")!;
    deps.queue.setFencingToken(job.id, 3); // stale (< 10)
    job.fencing_token = 3;
    await handler(job);
    expect(deps.state.getCurrent("demo")!.tag).toBe("v9-newer"); // fenced out
  });

  it("via the worker: rollback runs end-to-end under the per-service lock", async () => {
    const deps = setup(kubectlRouter({ undo: OK, image: "traefik/whoami:v1" }));
    deps.state.updateDeployment(deps.state.recordDeploymentStart("demo", "v1"), "done");
    const worker = new Worker({
      queue: deps.queue,
      handlers: { [ROLLBACK_JOB_KIND]: makeRollbackHandler({ state: deps.state, registry: deps.registry, pool: deps.pool }) },
      clock: deps.clock,
      holder: "w1",
    });
    const id = deps.state.recordDeploymentStart("demo", "v1", "rollback");
    deps.queue.enqueue({ id, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "demo", payload: { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1" } });
    expect(await worker.tick()).toBe(true);
    expect(deps.queue.getJob(id)!.state).toBe("done");
    expect(deps.state.getCurrent("demo")!.tag).toBe("v1");
  });
});
