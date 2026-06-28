import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";
import type { GitLike } from "../lib/git.ts";

const base = { sourceType: "git-sync", name: "site", namespace: "default", clusterId: "primary", gitUrl: "https://github.com/acme/repo.git", gitRef: "main", gitPath: "k8s", enabled: true };

function gitDeps(opts: { allowlist?: string[]; git?: GitLike } = {}) {
  const deps = makeFakeDeps({ gitConfig: { hostAllowlist: opts.allowlist ?? ["github.com"] }, git: opts.git });
  seedCluster(deps);
  return deps;
}

describe("git-sync service create (SSRF allowlist + traversal)", () => {
  it("creates a git-sync service for an allowlisted host", async () => {
    const r = await call(buildApp(gitDeps()), "POST", "/api/services", base);
    expect(r.status).toBe(201);
    expect(r.body.service.sourceType).toBe("git-sync");
  });

  it("refuses git-sync entirely when the allowlist is empty", async () => {
    const r = await call(buildApp(gitDeps({ allowlist: [] })), "POST", "/api/services", base);
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("disabled");
  });

  it("rejects a non-allowlisted host (incl. a userinfo-masquerade)", async () => {
    expect((await call(buildApp(gitDeps()), "POST", "/api/services", { ...base, gitUrl: "https://evil.com/a/b.git" })).status).toBe(422);
    const masq = await call(buildApp(gitDeps()), "POST", "/api/services", { ...base, name: "m", gitUrl: "https://github.com@evil.com/a/b.git" });
    expect(masq.status).toBe(422);
  });

  it("rejects a traversal gitPath", async () => {
    const r = await call(buildApp(gitDeps()), "POST", "/api/services", { ...base, gitPath: "../../etc" });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("..");
  });

  it("rejects a deploy key path outside the keys dir", async () => {
    const r = await call(buildApp(gitDeps()), "POST", "/api/services", { ...base, deployKeyPath: "../../root/.ssh/id_rsa" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("key-outside-allowed-dir");
  });

  it("GET /versions lists the ref tip sha via ls-remote", async () => {
    const sha = "9d3a1f2b4c5d6e7f8091a2b3c4d5e6f70819a2b3";
    const git: GitLike = { run: async (args) => (args[0] === "ls-remote" ? { code: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" }) };
    const deps = gitDeps({ git });
    await call(buildApp(deps), "POST", "/api/services", base);
    const r = await call(buildApp(deps), "GET", "/api/services/site/versions");
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("git");
    expect(r.body.items).toEqual([{ tag: sha }]);
  });
});
