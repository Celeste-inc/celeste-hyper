import { describe, it, expect } from "bun:test";
import { validateGitUrl, gitHost, validateGitPath, validateDeployKeyPath, parseLsRemote } from "./git.ts";

describe("gitHost", () => {
  it("parses https, ssh, and scp-like URLs", () => {
    expect(gitHost("https://github.com/acme/repo.git")).toBe("github.com");
    expect(gitHost("https://user@gitlab.example.com:8443/acme/repo.git")).toBe("gitlab.example.com");
    expect(gitHost("ssh://git@github.com:22/acme/repo.git")).toBe("github.com");
    expect(gitHost("git@github.com:acme/repo.git")).toBe("github.com");
  });
  it("returns null for unparseable input", () => {
    expect(gitHost("not a url")).toBeNull();
    expect(gitHost("/local/path")).toBeNull();
  });
});

describe("validateGitUrl (SSRF allowlist)", () => {
  it("an empty allowlist disables git-sync entirely", () => {
    expect(validateGitUrl("https://github.com/a/b.git", [])).toEqual({ ok: false, error: expect.stringContaining("disabled") });
  });
  it("allows an allowlisted host (case-insensitive) and rejects others", () => {
    expect(validateGitUrl("https://GitHub.com/a/b.git", ["github.com"])).toEqual({ ok: true });
    expect(validateGitUrl("git@github.com:a/b.git", ["github.com"])).toEqual({ ok: true });
    expect(validateGitUrl("https://evil.com/a/b.git", ["github.com"])).toEqual({ ok: false, error: expect.stringContaining("not in the allowlist") });
  });
  it("does not let a non-allowlisted host masquerade via userinfo", () => {
    // host is evil.com, not github.com — the userinfo before @ must not be treated as the host
    expect(validateGitUrl("https://github.com@evil.com/a/b.git", ["github.com"])).toEqual({ ok: false, error: expect.stringContaining("not in the allowlist") });
  });

  it("is not fooled by a '#' or '?' before the @allowlisted-host (the authority ends at #/? like git does)", () => {
    // git connects to evil.com (authority ends at # / ?); a regex userinfo group would wrongly read github.com
    expect(validateGitUrl("https://evil.com#@github.com/a/b.git", ["github.com"]).ok).toBe(false);
    expect(validateGitUrl("https://evil.com?@github.com/a/b.git", ["github.com"]).ok).toBe(false);
    expect(gitHost("https://evil.com#@github.com/a/b.git")).toBe("evil.com");
    expect(gitHost("https://evil.com?@github.com/a/b.git")).toBe("evil.com");
  });

  it("rejects command-bearing / local transports (ext::, file://) even if the 'host' is allowlisted", () => {
    expect(validateGitUrl("ext::sh -c 'id'", ["ext", "github.com"]).ok).toBe(false);
    expect(validateGitUrl("file:///etc/passwd", ["github.com"]).ok).toBe(false);
    expect(validateGitUrl("fd::17", ["fd"]).ok).toBe(false);
  });

  it("still accepts the scp form (host:path) which has no scheme", () => {
    expect(validateGitUrl("github.com:acme/repo.git", ["github.com"])).toEqual({ ok: true });
  });
});

describe("validateGitPath (traversal)", () => {
  it("accepts repo-relative paths", () => {
    expect(validateGitPath("k8s")).toEqual({ ok: true, path: "k8s" });
    expect(validateGitPath("deploy/overlays/prod")).toEqual({ ok: true, path: "deploy/overlays/prod" });
    expect(validateGitPath("")).toEqual({ ok: true, path: "." });
  });
  it("rejects traversal, absolute, and ..-escaping paths", () => {
    expect(validateGitPath("../etc").ok).toBe(false);
    expect(validateGitPath("a/../../b").ok).toBe(false);
    expect(validateGitPath("/etc/passwd").ok).toBe(false);
    expect(validateGitPath("deploy/../../root").ok).toBe(false);
  });
});

describe("validateDeployKeyPath (traversal)", () => {
  const dir = "/etc/celeste-hyper/git-keys";
  it("accepts a key inside the keys dir", () => {
    expect(validateDeployKeyPath("github.pem", dir)).toEqual({ ok: true });
    expect(validateDeployKeyPath("/etc/celeste-hyper/git-keys/team/k.pem", dir)).toEqual({ ok: true });
  });
  it("rejects a key outside the keys dir", () => {
    expect(validateDeployKeyPath("../../root/.ssh/id_rsa", dir)).toEqual({ ok: false, error: "key-outside-allowed-dir" });
    expect(validateDeployKeyPath("/etc/shadow", dir)).toEqual({ ok: false, error: "key-outside-allowed-dir" });
    expect(validateDeployKeyPath("", dir)).toEqual({ ok: false, error: "key-outside-allowed-dir" }); // the dir itself isn't a key
  });
});

describe("parseLsRemote", () => {
  it("extracts the 40-hex SHA", () => {
    expect(parseLsRemote("9d3a1f2b4c5d6e7f8091a2b3c4d5e6f70819a2b3\trefs/heads/main\n")).toBe("9d3a1f2b4c5d6e7f8091a2b3c4d5e6f70819a2b3");
  });
  it("returns null when there is no SHA line", () => {
    expect(parseLsRemote("")).toBeNull();
    expect(parseLsRemote("fatal: repository not found")).toBeNull();
  });
});
