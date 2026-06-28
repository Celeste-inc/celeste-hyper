import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../lib/state.ts";
import { fakeClock } from "../lib/clock.ts";
import { Deployer } from "./deploy.ts";
import type { GitLike } from "../lib/git.ts";
import type { GitSyncService } from "./model.ts";

const OK = { code: 0, stdout: "", stderr: "" };
const SHA = "9d3a1f2b4c5d6e7f8091a2b3c4d5e6f70819a2b3";

function svc(over: Partial<GitSyncService> = {}): GitSyncService {
  return {
    sourceType: "git-sync",
    name: "site",
    namespace: "default",
    clusterId: "c1",
    gitUrl: "https://github.com/acme/repo.git",
    gitRef: "main",
    gitPath: "k8s",
    enabled: true,
    ...over,
  } as GitSyncService;
}

function fakeK8s() {
  const applied: string[] = [];
  const k8s = {
    runtime: "docker",
    applyFile: async (file: string) => (applied.push(file), OK),
    upsertConfigMapFromEnvFile: async () => OK,
    upsertSecretFromEnvFile: async () => OK,
  };
  return { k8s, applied };
}

/** A git that "clones" by materializing a manifest dir on disk, and rev-parses to a fixed sha. */
function fakeGit(opts: { cloneCode?: number; materialize?: boolean; symlinkTo?: string } = {}): GitLike {
  return {
    run: async (args) => {
      if (args.includes("clone")) {
        if (opts.cloneCode && opts.cloneCode !== 0) return { code: opts.cloneCode, stdout: "", stderr: "fatal: could not read from remote" };
        const dest = args[args.length - 1]!;
        if (opts.symlinkTo) {
          symlinkSync(opts.symlinkTo, join(dest, "k8s")); // malicious repo: gitPath is a symlink out
        } else if (opts.materialize !== false) {
          mkdirSync(join(dest, "k8s"), { recursive: true });
          writeFileSync(join(dest, "k8s", "deployment.yaml"), "kind: Deployment\n");
        }
        return OK;
      }
      if (args.includes("rev-parse")) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
      return OK;
    },
  };
}

function makeDeployer(state: State, clock: ReturnType<typeof fakeClock>, k8s: unknown, git: GitLike, workDir: string) {
  const pool = { getOrThrow: () => k8s, get: () => k8s } as never;
  const cfg = { workDir, envFilesDir: join(workDir, "env"), git: { hostAllowlist: ["github.com"], keysDir: "/etc/celeste-hyper/git-keys" } } as never;
  return new Deployer(cfg, {} as never, pool, state, clock, git);
}

describe("Deployer git-sync", () => {
  it("clones the ref, applies the manifest dir, and records the resolved sha", async () => {
    const clock = fakeClock(0);
    const state = new State(":memory:", clock);
    const workDir = mkdtempSync(join(tmpdir(), "hyper-gitsync-"));
    const { k8s, applied } = fakeK8s();
    const id = state.recordDeploymentStart("site", "main");
    const res = await makeDeployer(state, clock, k8s, fakeGit(), workDir).deployExisting({ service: svc(), tag: "main" }, id);
    expect(res.ok).toBe(true);
    expect(applied[0]).toContain(join("site", "git", "k8s")); // applied the cloned gitPath dir
    expect(state.getCurrent("site")!.tag).toBe(SHA); // resolved HEAD sha, not the ref
  });

  it("rejects a gitPath that is a symlink escaping the clone root (containment)", async () => {
    const clock = fakeClock(0);
    const state = new State(":memory:", clock);
    const workDir = mkdtempSync(join(tmpdir(), "hyper-gitsync-"));
    const outside = mkdtempSync(join(tmpdir(), "hyper-outside-"));
    const { k8s, applied } = fakeK8s();
    const id = state.recordDeploymentStart("site", "main");
    const res = await makeDeployer(state, clock, k8s, fakeGit({ symlinkTo: outside }), workDir).deployExisting({ service: svc(), tag: "main" }, id);
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => !s.ok)?.name).toBe("manifests");
    expect(applied).toHaveLength(0); // never applied the escaped dir
  });

  it("fails the deploy when git clone fails", async () => {
    const clock = fakeClock(0);
    const state = new State(":memory:", clock);
    const workDir = mkdtempSync(join(tmpdir(), "hyper-gitsync-"));
    const { k8s } = fakeK8s();
    const id = state.recordDeploymentStart("site", "main");
    const res = await makeDeployer(state, clock, k8s, fakeGit({ cloneCode: 128 }), workDir).deployExisting({ service: svc(), tag: "main" }, id);
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => !s.ok)?.name).toBe("git-clone");
  });

  it("refuses a non-allowlisted host at deploy time (defense in depth)", async () => {
    const clock = fakeClock(0);
    const state = new State(":memory:", clock);
    const workDir = mkdtempSync(join(tmpdir(), "hyper-gitsync-"));
    const { k8s } = fakeK8s();
    const id = state.recordDeploymentStart("site", "main");
    const res = await makeDeployer(state, clock, k8s, fakeGit(), workDir).deployExisting({ service: svc({ gitUrl: "https://evil.com/a/b.git" }), tag: "main" }, id);
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => !s.ok)?.name).toBe("validate");
  });

  it("fails when the gitPath is missing from the cloned repo", async () => {
    const clock = fakeClock(0);
    const state = new State(":memory:", clock);
    const workDir = mkdtempSync(join(tmpdir(), "hyper-gitsync-"));
    const { k8s } = fakeK8s();
    const id = state.recordDeploymentStart("site", "main");
    // materialize:false → clone "succeeds" but writes no files, so gitPath 'k8s' won't exist
    const res = await makeDeployer(state, clock, k8s, fakeGit({ materialize: false }), workDir).deployExisting({ service: svc(), tag: "main" }, id);
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => !s.ok)?.name).toBe("manifests");
  });
});
