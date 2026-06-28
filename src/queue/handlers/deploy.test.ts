import { describe, it, expect } from "bun:test";
import { State } from "../../lib/state.ts";
import { Registry } from "../../services/registry.ts";
import { fakeClock } from "../../lib/clock.ts";
import { Queue } from "../queue.ts";
import { Worker } from "../worker.ts";
import { makeDeployHandler, DEPLOY_JOB_KIND } from "./deploy.ts";
import type { Deployer, DeployResult } from "../../services/deploy.ts";

function setup() {
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
  } as never);
  const queue = new Queue(state, clock);
  return { clock, state, registry, queue };
}

function fakeDeployer(impl: Deployer["deployExisting"]): Deployer {
  return { deployExisting: impl } as unknown as Deployer;
}

const okResult = (id: number): DeployResult => ({ deploymentId: id, ok: true, steps: [] });

describe("deploy job handler", () => {
  it("invokes deployExisting with the job id, tag, and fencing token, against a pending row", async () => {
    const { state, registry, queue } = setup();
    let seen: { id?: number; tag?: string; token?: number; statusAtStart?: string } = {};
    const deployer = fakeDeployer(async (req, id, token) => {
      seen = { id, tag: req.tag, token, statusAtStart: state.deploymentById(id)?.status };
      return okResult(id);
    });
    const handler = makeDeployHandler({ state, registry, deployer });

    const depId = state.recordDeploymentStart("hello", "v1"); // enqueuer creates the row first
    queue.enqueue({ id: depId, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { tag: "v1" } });
    const job = queue.claim("w1")!;
    queue.setFencingToken(job.id, 7);
    job.fencing_token = 7;

    await handler(job);
    expect(seen.id).toBe(depId);
    expect(seen.tag).toBe("v1");
    expect(seen.token).toBe(7);
    expect(seen.statusAtStart).toBe("pending");
  });

  it("self-creates the deployment row in pending when run in isolation", async () => {
    const { state, registry, queue } = setup();
    const handler = makeDeployHandler({ state, registry, deployer: fakeDeployer(async (_r, id) => okResult(id)) });
    queue.enqueue({ id: 99, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { tag: "v9" } });
    const job = queue.claim("w1")!;
    expect(state.deploymentById(99)).toBeNull(); // enqueue did not create it

    await handler(job);
    const row = state.deploymentById(99)!;
    expect(row.service).toBe("hello");
    expect(row.tag).toBe("v9");
  });

  it("throws the failing step's message when the deploy fails", async () => {
    const { state, registry, queue } = setup();
    const deployer = fakeDeployer(async (_r, id) => ({
      deploymentId: id,
      ok: false,
      steps: [{ name: "set-image", ok: false, message: "kubectl: Error from server (NotFound)" }],
    }));
    const handler = makeDeployHandler({ state, registry, deployer });
    queue.enqueue({ id: 1, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: "hello", payload: { tag: "v1" } });
    const job = queue.claim("w1")!;
    await expect(handler(job)).rejects.toThrow("Error from server (NotFound)");
  });

  it("throws when the service no longer exists", async () => {
    const { state, registry, queue } = setup();
    const handler = makeDeployHandler({ state, registry, deployer: fakeDeployer(async (_r, id) => okResult(id)) });
    queue.enqueue({ id: 1, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: "ghost", payload: { tag: "v1" } });
    const job = queue.claim("w1")!;
    await expect(handler(job)).rejects.toThrow("not found");
  });

  it("via the worker: a failing deploy is captured in last_error", async () => {
    const { state, registry, queue, clock } = setup();
    const deployer = fakeDeployer(async (_r, id) => ({
      deploymentId: id,
      ok: false,
      steps: [{ name: "rollout", ok: false, message: "kubectl: timed out waiting for condition" }],
    }));
    const worker = new Worker({
      queue,
      handlers: { [DEPLOY_JOB_KIND]: makeDeployHandler({ state, registry, deployer }) },
      clock,
      holder: "w1",
    });
    const depId = state.recordDeploymentStart("hello", "v1");
    queue.enqueue({
      id: depId,
      kind: DEPLOY_JOB_KIND,
      resourceKind: "service",
      resourceId: "hello",
      payload: { tag: "v1" },
      maxAttempts: 1,
    });
    await worker.tick();
    const job = queue.getJob(depId)!;
    expect(job.state).toBe("failed");
    expect(job.last_error).toContain("timed out");
  });
});
