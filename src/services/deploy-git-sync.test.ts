import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
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

describe("Deployer env guard", () => {
  const latestMessage = (state: State) =>
    [...state.recentDeployments("site")].sort((a, b) => b.id - a.id)[0]!.message;

  function cluster() {
    const live: Record<string, Record<string, string>> = {};
    let failManifests = false;
    let liveReadError: string | null = null;
    const toFileData = (file: string) => Object.fromEntries(
      readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const k8s = {
      runtime: "docker",
      applyFile: async () => (failManifests ? { code: 1, stdout: "", stderr: "apply failed" } : OK),
      upsertConfigMapFromEnvFile: async (name: string, file: string) => ((live[name] = toFileData(file)), OK),
      upsertSecretFromEnvFile: async (name: string, file: string) => ((live[name] = toFileData(file)), OK),
      kubectl: async (args: string[]) => {
        if (liveReadError) return { code: 1, stdout: "", stderr: liveReadError };
        const kind = args[3]!;
        const name = args[4]!;
        const data = live[name];
        if (!data) return { code: 1, stdout: "", stderr: `Error from server (NotFound): ${kind}s "${name}" not found` };
        const encoded = kind === "secret" ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString("base64")])) : data;
        return { code: 0, stdout: JSON.stringify({ data: encoded }), stderr: "" };
      },
    };
    const controls = {
      failManifests: (value: boolean) => { failManifests = value; },
      failLiveRead: (message: string | null) => { liveReadError = message; },
    };
    return { k8s, live, controls };
  }

  function setup(mode: "warn" | "block") {
    const clock = fakeClock(0);
    const state = new State(":memory:", clock);
    const workDir = mkdtempSync(join(tmpdir(), "hyper-envguard-"));
    const envDir = join(workDir, "env");
    const writeEnv = (kind: "config" | "secret", content: string) => {
      mkdirSync(join(envDir, "site"), { recursive: true });
      writeFileSync(join(envDir, "site", `${kind}.env`), content);
    };
    const { k8s, live, controls } = cluster();
    const pool = { getOrThrow: () => k8s, get: () => k8s } as never;
    const stateDir = join(workDir, "state");
    const cfg = { workDir, envFilesDir: envDir, stateDir, envGuard: mode, git: { hostAllowlist: ["github.com"], keysDir: "/etc/celeste-hyper/git-keys" } } as never;
    const deployer = new Deployer(cfg, {} as never, pool, state, clock, fakeGit());
    const deploy = (allowEnvDrift = false) => {
      const id = state.recordDeploymentStart("site", "main");
      return deployer.deployExisting({ service: svc(), tag: "main", allowEnvDrift }, id);
    };
    return { state, live, writeEnv, deploy, controls, stateDir };
  }

  it("records the baseline on success and blocks a redeploy that would revert a cluster edit", async () => {
    const { state, live, writeEnv, deploy } = setup("block");
    writeEnv("config", "DB_NAME=prod\nSHARE=records\n");
    writeEnv("secret", "PASSWORD=s3cr3t\n");
    expect((await deploy()).ok).toBe(true);
    expect(Object.keys(state.getEnvBaseline("site", "config")!).sort()).toEqual(["DB_NAME", "SHARE"]);
    expect(JSON.stringify(state.getEnvBaseline("site", "secret"))).not.toContain("s3cr3t");

    live["site-config"]!.SHARE = "records_hotfix";
    const blocked = await deploy();
    expect(blocked.ok).toBe(false);
    const step = blocked.steps.find((s) => !s.ok)!;
    expect(step.name).toBe("env-drift");
    expect(step.message).toContain("SHARE");
    expect(step.message).not.toContain("records_hotfix");
    expect(live["site-config"]!.SHARE).toBe("records_hotfix");
  });

  it("allows a key intentionally changed through hyper", async () => {
    const { live, writeEnv, deploy } = setup("block");
    writeEnv("config", "DB_NAME=prod\n");
    writeEnv("secret", "");
    expect((await deploy()).ok).toBe(true);
    live["site-config"]!.DB_NAME = "manual";
    writeEnv("config", "DB_NAME=prod_v2\n");
    expect((await deploy()).ok).toBe(true);
    expect(live["site-config"]!.DB_NAME).toBe("prod_v2");
  });

  it("applies with an explicit override and records the warning", async () => {
    const { state, live, writeEnv, deploy } = setup("block");
    writeEnv("config", "DB_NAME=prod\n");
    writeEnv("secret", "");
    await deploy();
    live["site-config"]!.DB_NAME = "manual";
    const res = await deploy(true);
    expect(res.ok).toBe(true);
    expect(live["site-config"]!.DB_NAME).toBe("prod");
    expect(latestMessage(state)).toContain("env drift overridden");
  });

  it("rejects keys duplicated across config and secret in block mode and only warns in warn mode", async () => {
    const blocking = setup("block");
    blocking.writeEnv("config", "DB_NAME=prod\n");
    blocking.writeEnv("secret", "DB_NAME=other\nPASSWORD=x\n");
    const res = await blocking.deploy();
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => !s.ok)).toMatchObject({ name: "env-duplicate-keys", message: "keys defined in both config.env and secret.env: DB_NAME" });
    expect(blocking.live["site-config"]).toBeUndefined();

    const warning = setup("warn");
    warning.writeEnv("config", "DB_NAME=prod\n");
    warning.writeEnv("secret", "DB_NAME=other\n");
    expect((await warning.deploy()).ok).toBe(true);
    expect(latestMessage(warning.state)).toContain("keys defined in both config.env and secret.env: DB_NAME");
  });

  it("only warns on the first guarded deploy when the cluster already differs", async () => {
    const { state, live, writeEnv, deploy } = setup("block");
    live["site-config"] = { DB_NAME: "prod" };
    writeEnv("config", "DB_NAME=stale\n");
    writeEnv("secret", "");
    const res = await deploy();
    expect(res.ok).toBe(true);
    expect(latestMessage(state)).toContain("no applied baseline; values differ from the cluster: DB_NAME");
  });

  it("records the baseline as soon as the env is applied, even when the manifests fail", async () => {
    const { state, writeEnv, deploy, controls } = setup("block");
    writeEnv("config", "DB_NAME=prod\n");
    writeEnv("secret", "");
    controls.failManifests(true);
    expect((await deploy()).ok).toBe(false);
    expect(Object.keys(state.getEnvBaseline("site", "config")!)).toEqual(["DB_NAME"]);

    controls.failManifests(false);
    writeEnv("config", "DB_NAME=reverted\n");
    expect((await deploy()).ok).toBe(true);
  });

  it("reports a live read failure as a retryable step in block mode and only warns in warn mode", async () => {
    const blocking = setup("block");
    blocking.writeEnv("config", "DB_NAME=prod\n");
    blocking.writeEnv("secret", "");
    blocking.controls.failLiveRead("Unable to connect to the server");
    const res = await blocking.deploy();
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => !s.ok)?.name).toBe("env-live-read");

    const warning = setup("warn");
    warning.writeEnv("config", "DB_NAME=prod\n");
    warning.writeEnv("secret", "");
    warning.controls.failLiveRead("Unable to connect to the server");
    expect((await warning.deploy()).ok).toBe(true);
    expect(latestMessage(warning.state)).toContain("env drift check skipped");
  });

  it("keeps deploying in warn mode when the guard itself throws", async () => {
    const { state, live, writeEnv, deploy, stateDir } = setup("warn");
    writeFileSync(stateDir, "not a directory");
    writeEnv("config", "DB_NAME=prod\n");
    writeEnv("secret", "");
    expect((await deploy()).ok).toBe(true);
    expect(live["site-config"]!.DB_NAME).toBe("prod");
    expect(latestMessage(state)).toContain("[warn] env guard failed");
  });
});
