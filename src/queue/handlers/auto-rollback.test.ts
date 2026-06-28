import { describe, it, expect } from "bun:test";
import { State } from "../../lib/state.ts";
import { Registry } from "../../services/registry.ts";
import { fakeClock } from "../../lib/clock.ts";
import type { RunResult } from "../../lib/k8s.ts";
import type { K8sPool } from "../../services/k8s-pool.ts";
import type { Deployer, DeployResult } from "../../services/deploy.ts";
import { Queue } from "../queue.ts";
import { Worker } from "../worker.ts";
import { makeDeployHandler, DEPLOY_JOB_KIND, AUTO_ROLLBACK_GRACE_MS } from "./deploy.ts";
import { makeRollbackHandler, ROLLBACK_JOB_KIND } from "./rollback.ts";

const OK: RunResult = { code: 0, stdout: "", stderr: "" };

type KubectlFn = (args: string[]) => RunResult;

function fakeK8s(kubectl: KubectlFn) {
  return { kubectl: async (a: string[]) => kubectl(a), rolloutStatus: async () => OK };
}
function fakePool(k8s: unknown): K8sPool {
  return { get: () => k8s, getOrThrow: () => k8s } as unknown as K8sPool;
}
function fakeDeployer(impl: Deployer["deployExisting"]): Deployer {
  return { deployExisting: impl } as unknown as Deployer;
}

/** A deploy result whose health-gate step failed. */
const gateFail = (id: number): DeployResult => ({
  deploymentId: id,
  ok: false,
  steps: [
    { name: "set-image", ok: true, message: "image set" },
    { name: "health-gate", ok: false, message: "health gate failed: readyReplicas 0/3" },
  ],
});

/** A deploy result that failed for a non-gate reason. */
const otherFail = (id: number): DeployResult => ({
  deploymentId: id,
  ok: false,
  steps: [{ name: "set-image", ok: false, message: "kubectl: Error from server (NotFound)" }],
});

function setup(serviceOver: Record<string, unknown> = {}, image = "traefik/whoami:v1") {
  const clock = fakeClock(0);
  const state = new State(":memory:", clock);
  const registry = new Registry(state);
  registry.create({
    sourceType: "registry-pull",
    name: "hello",
    namespace: "default",
    clusterId: "primary",
    imageRef: "traefik/whoami",
    workloadKind: "Deployment",
    enabled: true,
    ...serviceOver,
  } as never);
  const pool = fakePool(
    fakeK8s((args) => {
      if (args.includes("history")) return { code: 1, stdout: "", stderr: "no cluster history" };
      if (args.includes("undo")) return OK;
      if (args.includes("get")) return { code: 0, stdout: image, stderr: "" };
      return OK;
    }),
  );
  const queue = new Queue(state, clock);
  return { clock, state, registry, pool, queue };
}

/** Seed hyper history so the rollback target resolves to v1 (Source A), current = v2. */
function seedHistory(state: State) {
  state.updateDeployment(state.recordDeploymentStart("hello", "v1"), "done");
  state.updateDeployment(state.recordDeploymentStart("hello", "v2"), "done");
  state.setCurrent("hello", "v2");
}

async function runDeploy(deps: ReturnType<typeof setup>, deployer: Deployer, tag = "v3") {
  const handler = makeDeployHandler({ state: deps.state, registry: deps.registry, deployer, queue: deps.queue, pool: deps.pool });
  const id = deps.state.recordDeploymentStart("hello", tag);
  deps.queue.enqueue({ id, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { tag } });
  const job = deps.queue.claim("w1")!;
  return { id, run: handler(job) };
}

describe("auto-rollback on a failed health gate", () => {
  it("enqueues a grace-delayed rollback (auto:true, expectedTag=previous) when autoRollback is on", async () => {
    const deps = setup({ autoRollback: true });
    seedHistory(deps.state);
    const { run } = await runDeploy(deps, fakeDeployer(async (_r, id) => gateFail(id)));
    await expect(run).rejects.toThrow("health gate failed");

    const pending = deps.queue.pendingJob("hello", ROLLBACK_JOB_KIND)!;
    expect(pending).not.toBeNull();
    const payload = JSON.parse(pending.payload) as { auto?: boolean; expectedTag?: string; source?: string };
    expect(payload.auto).toBe(true);
    expect(payload.expectedTag).toBe("v1");
    expect(payload.source).toBe("hyper");
    // delayed by exactly the grace window
    expect(new Date(pending.next_attempt_at).getTime()).toBe(deps.clock.now() + AUTO_ROLLBACK_GRACE_MS);
    // a dedicated deployment row (action=rollback) backs the job
    expect(deps.state.deploymentById(pending.id)!.action).toBe("rollback");
  });

  it("does NOT enqueue a rollback when autoRollback is off", async () => {
    const deps = setup({ autoRollback: false });
    seedHistory(deps.state);
    const { run } = await runDeploy(deps, fakeDeployer(async (_r, id) => gateFail(id)));
    await expect(run).rejects.toThrow();
    expect(deps.queue.pendingJob("hello", ROLLBACK_JOB_KIND)).toBeNull();
  });

  it("does NOT enqueue for a non-gate failure even with autoRollback on", async () => {
    const deps = setup({ autoRollback: true });
    seedHistory(deps.state);
    const { run } = await runDeploy(deps, fakeDeployer(async (_r, id) => otherFail(id)));
    await expect(run).rejects.toThrow("NotFound");
    expect(deps.queue.pendingJob("hello", ROLLBACK_JOB_KIND)).toBeNull();
  });

  it("does NOT enqueue when there is no previous version to roll back to", async () => {
    const deps = setup({ autoRollback: true }); // no hyper history; fake cluster history returns none
    const { run } = await runDeploy(deps, fakeDeployer(async (_r, id) => gateFail(id)));
    await expect(run).rejects.toThrow();
    expect(deps.queue.pendingJob("hello", ROLLBACK_JOB_KIND)).toBeNull();
  });

  it("the operator can cancel the pending rollback inside the grace window", async () => {
    const deps = setup({ autoRollback: true });
    seedHistory(deps.state);
    const { run } = await runDeploy(deps, fakeDeployer(async (_r, id) => gateFail(id)));
    await expect(run).rejects.toThrow();
    const pending = deps.queue.pendingJob("hello", ROLLBACK_JOB_KIND)!;
    expect(deps.queue.cancelPending(pending.id)).toBe(true);
    expect(deps.queue.pendingJob("hello", ROLLBACK_JOB_KIND)).toBeNull();
    // a second cancel is a no-op (already removed)
    expect(deps.queue.cancelPending(pending.id)).toBe(false);
  });

  it("end-to-end via the worker: the rollback runs after the grace and wins on a higher fencing token", async () => {
    const deps = setup({ autoRollback: true });
    seedHistory(deps.state);
    const worker = new Worker({
      queue: deps.queue,
      handlers: {
        [DEPLOY_JOB_KIND]: makeDeployHandler({ state: deps.state, registry: deps.registry, deployer: fakeDeployer(async (_r, id) => gateFail(id)), queue: deps.queue, pool: deps.pool }),
        [ROLLBACK_JOB_KIND]: makeRollbackHandler({ state: deps.state, registry: deps.registry, pool: deps.pool }),
      },
      clock: deps.clock,
      holder: "w1",
    });
    const depId = deps.state.recordDeploymentStart("hello", "v3");
    deps.queue.enqueue({ id: depId, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { tag: "v3" }, maxAttempts: 1 });

    expect(await worker.tick()).toBe(true); // deploy fails the gate, enqueues the delayed rollback
    const deployJob = deps.queue.getJob(depId)!;
    expect(deployJob.state).toBe("failed");
    const pending = deps.queue.pendingJob("hello", ROLLBACK_JOB_KIND)!;
    expect(pending).not.toBeNull();

    expect(await worker.tick()).toBe(false); // still inside the grace window — not yet claimable
    deps.clock.advance(AUTO_ROLLBACK_GRACE_MS);
    expect(await worker.tick()).toBe(true); // rollback runs

    const rbJob = deps.queue.getJob(pending.id)!;
    expect(rbJob.state).toBe("done");
    expect(rbJob.fencing_token).toBeGreaterThan(deployJob.fencing_token);
    expect(deps.state.getCurrent("hello")!.tag).toBe("v1");
  });

  it("refuses to deploy a degraded service at the handler chokepoint (terminal, deployer never called)", async () => {
    const deps = setup({ autoRollback: true });
    deps.state.setServiceDegraded("hello", "auto-rollback failed earlier");
    let called = false;
    const deployer = fakeDeployer(async (_r, id) => {
      called = true;
      return gateFail(id);
    });
    const handler = makeDeployHandler({ state: deps.state, registry: deps.registry, deployer, queue: deps.queue, pool: deps.pool });
    const id = deps.state.recordDeploymentStart("hello", "v3");
    deps.queue.enqueue({ id, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { tag: "v3" } });
    const job = deps.queue.claim("w1")!;
    await expect(handler(job)).rejects.toThrow("service-degraded");
    expect(called).toBe(false); // deployExisting never invoked
    expect(deps.state.deploymentById(id)!.status).toBe("failed");
    expect(deps.queue.getJob(id)!.max_attempts).toBe(deps.queue.getJob(id)!.attempts); // noRetry applied
  });

  it("does not retry the deploy on a gate failure (no retry storm) and enqueues exactly one rollback", async () => {
    const deps = setup({ autoRollback: true });
    seedHistory(deps.state);
    const worker = new Worker({
      queue: deps.queue,
      handlers: {
        [DEPLOY_JOB_KIND]: makeDeployHandler({ state: deps.state, registry: deps.registry, deployer: fakeDeployer(async (_r, id) => gateFail(id)), queue: deps.queue, pool: deps.pool }),
        [ROLLBACK_JOB_KIND]: makeRollbackHandler({ state: deps.state, registry: deps.registry, pool: deps.pool }),
      },
      clock: deps.clock,
      holder: "w1",
    });
    const depId = deps.state.recordDeploymentStart("hello", "v3");
    // default max_attempts = 3 — without noRetry the deploy would re-run and re-apply the bad image
    deps.queue.enqueue({ id: depId, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { tag: "v3" } });

    expect(await worker.tick()).toBe(true);
    const deployJob = deps.queue.getJob(depId)!;
    expect(deployJob.state).toBe("failed"); // terminal after ONE attempt, not retried
    expect(deployJob.attempts).toBe(1);

    const rollbacks = deps.state.database.query("SELECT COUNT(*) AS c FROM jobs WHERE kind = ?").get(ROLLBACK_JOB_KIND) as { c: number };
    expect(rollbacks.c).toBe(1);

    // draining the queue (advance past the grace) must not re-run the deploy
    deps.clock.advance(AUTO_ROLLBACK_GRACE_MS);
    expect(await worker.tick()).toBe(true); // the rollback
    expect(await worker.tick()).toBe(false); // nothing left — deploy never retried
    expect(deps.queue.getJob(depId)!.attempts).toBe(1);
  });

  it("dedups: does not enqueue a second rollback while one is already active", async () => {
    const deps = setup({ autoRollback: true });
    seedHistory(deps.state);
    // a rollback is already queued for this service (e.g. from a prior failing deploy)
    const existing = deps.state.recordDeploymentStart("hello", "v1", "rollback");
    deps.queue.enqueue({ id: existing, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { auto: true }, delayMs: AUTO_ROLLBACK_GRACE_MS });

    const { run } = await runDeploy(deps, fakeDeployer(async (_r, id) => gateFail(id)));
    await expect(run).rejects.toThrow();

    const rollbacks = deps.state.database.query("SELECT COUNT(*) AS c FROM jobs WHERE kind = ?").get(ROLLBACK_JOB_KIND) as { c: number };
    expect(rollbacks.c).toBe(1); // still just the pre-existing one
  });

  it("marks the service degraded when an AUTOMATIC rollback itself fails", async () => {
    const deps = setup({ autoRollback: true }, "traefik/whoami:v1");
    // fake an undo failure
    const pool = fakePool({ kubectl: async (a: string[]) => (a.includes("undo") ? { code: 1, stdout: "", stderr: "Error from server" } : OK), rolloutStatus: async () => OK });
    const handler = makeRollbackHandler({ state: deps.state, registry: deps.registry, pool });
    const id = deps.state.recordDeploymentStart("hello", "v1", "rollback");
    deps.queue.enqueue({ id, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1", auto: true } });
    const job = deps.queue.claim("w1")!;
    await expect(handler(job)).rejects.toThrow("Error from server");
    expect(deps.state.serviceDegraded("hello")).not.toBeNull();
  });

  it("does NOT mark degraded when a MANUAL rollback fails (auto flag absent)", async () => {
    const deps = setup({ autoRollback: true });
    const pool = fakePool({ kubectl: async (a: string[]) => (a.includes("undo") ? { code: 1, stdout: "", stderr: "Error from server" } : OK), rolloutStatus: async () => OK });
    const handler = makeRollbackHandler({ state: deps.state, registry: deps.registry, pool });
    const id = deps.state.recordDeploymentStart("hello", "v1", "rollback");
    deps.queue.enqueue({ id, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1" } });
    const job = deps.queue.claim("w1")!;
    await expect(handler(job)).rejects.toThrow("Error from server");
    expect(deps.state.serviceDegraded("hello")).toBeNull();
  });

  it("a successful rollback clears a pre-existing degraded mark", async () => {
    const deps = setup({ autoRollback: true });
    deps.state.setServiceDegraded("hello", "left over from a prior failed auto-rollback");
    const handler = makeRollbackHandler({ state: deps.state, registry: deps.registry, pool: deps.pool });
    const id = deps.state.recordDeploymentStart("hello", "v1", "rollback");
    deps.queue.enqueue({ id, kind: ROLLBACK_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { previousTag: "v1", previousRevision: null, source: "hyper", expectedTag: "v1" } });
    const job = deps.queue.claim("w1")!;
    deps.queue.setFencingToken(job.id, 5);
    job.fencing_token = 5;
    await handler(job);
    expect(deps.state.serviceDegraded("hello")).toBeNull();
  });
});
