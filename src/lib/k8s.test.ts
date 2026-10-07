import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { K8s, type RunResult } from "./k8s.ts";
import { serializeRows, type EnvRow } from "./env-files.ts";
import { imageImportCommand } from "./k8s.ts";

describe("imageImportCommand", () => {
  it("does not require sudo when running as root", () => {
    expect(imageImportCommand("k3s", "/tmp/app.tar", 0, false)).toEqual(["k3s", "ctr", "images", "import", "/tmp/app.tar"]);
    expect(imageImportCommand("containerd", "/tmp/app.tar", 0, false)).toEqual(["ctr", "-n=k8s.io", "images", "import", "/tmp/app.tar"]);
  });

  it("uses sudo for non-root k3s/containerd when sudo is available", () => {
    expect(imageImportCommand("k3s", "/tmp/app.tar", 1000, true, true)).toEqual(["sudo", "k3s", "ctr", "images", "import", "/tmp/app.tar"]);
    expect(imageImportCommand("containerd", "/tmp/app.tar", 1000, true, false)).toEqual(["sudo", "ctr", "-n=k8s.io", "images", "import", "/tmp/app.tar"]);
  });

  it("prefers k3s ctr for containerd imports when k3s is available", () => {
    expect(imageImportCommand("containerd", "/tmp/app.tar", 0, false, true)).toEqual(["k3s", "ctr", "images", "import", "/tmp/app.tar"]);
  });

  it("keeps docker load unchanged", () => {
    expect(imageImportCommand("docker", "/tmp/app.tar", 0, true)).toEqual(["docker", "load", "-i", "/tmp/app.tar"]);
  });
});

describe("upsert*FromEnvFile", () => {
  // Values that made the previous `kubectl create --from-env-file` path fail: our
  // serializer quotes anything containing `=`, `#` or a quote, and that flag takes
  // everything after the first `=` literally, quotes included.
  const USERS_DN = "DC=EXAMPLE,DC=TEST";
  const GROUP_DN = "CN=sample-group,OU=Sample Unit,DC=EXAMPLE,DC=TEST";

  function envFileWith(rows: EnvRow[]): string {
    const path = join(tmpdir(), `hyper-env-${Math.random().toString(36).slice(2)}.env`);
    writeFileSync(path, serializeRows(rows).content);
    return path;
  }

  class CapturingK8s extends K8s {
    manifests: string[] = [];
    override kubectl(_args: string[], stdin?: string): Promise<RunResult> {
      this.manifests.push(stdin ?? "");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
  }

  const k8s = () => new CapturingK8s({ runtime: "docker", namespace: "demo-ns", kubeconfig: undefined });

  it("keeps a value containing '=' free of the serializer's quotes", async () => {
    const file = envFileWith([{ key: "USERS_DN", value: USERS_DN }]);
    // The file on disk really is quoted — that is the input the old path mangled.
    expect(readFileSync(file).toString()).toContain(`USERS_DN="${USERS_DN}"`);

    const c = k8s();
    await c.upsertConfigMapFromEnvFile("demo-config", file, "demo-ns");

    // Exactly one level of YAML quoting: no escaped inner quotes (\") reach the cluster.
    expect(c.manifests[0]).toContain(`USERS_DN: "${USERS_DN}"`);
    expect(c.manifests[0]).not.toContain('\\"');
  });

  it("survives JSON-template substitution, which is what used to break on import", async () => {
    const file = envFileWith([{ key: "USERS_DN", value: USERS_DN }]);
    const c = k8s();
    await c.upsertConfigMapFromEnvFile("cm", file, "demo-ns");

    // Recover the value the cluster would hold, then substitute it into a JSON template
    // the way a consumer that reads env into JSON does.
    const value = c.manifests[0]!.match(/USERS_DN: "(.*)"/)![1]!;
    const substituted = `["${value}"]`;
    expect(JSON.parse(substituted)).toEqual([USERS_DN]); // one element, not two
  });

  it("handles spaces, commas and '#' in the same value", async () => {
    const file = envFileWith([
      { key: "GROUP_DN", value: GROUP_DN },
      { key: "WITH_HASH", value: "a#b" },
    ]);
    const c = k8s();
    await c.upsertConfigMapFromEnvFile("cm", file, "ns");
    expect(c.manifests[0]).toContain(`GROUP_DN: "${GROUP_DN}"`);
    expect(c.manifests[0]).toContain('WITH_HASH: "a#b"');
  });

  it("carries an embedded newline, which an env-file cannot represent", async () => {
    const file = envFileWith([{ key: "PEM", value: "line1\nline2" }]);
    const c = k8s();
    await c.upsertConfigMapFromEnvFile("cm", file, "ns");
    expect(c.manifests[0]).toContain('PEM: "line1\\nline2"');
  });

  it("writes secrets as stringData so the API server does the base64", async () => {
    const file = envFileWith([{ key: "BIND_CREDENTIAL", value: "p@ss=word,x" }]);
    const c = k8s();
    await c.upsertSecretFromEnvFile("demo-secret", file, "demo-ns");
    expect(c.manifests[0]).toContain("kind: Secret");
    expect(c.manifests[0]).toContain("stringData:");
    expect(c.manifests[0]).toContain('BIND_CREDENTIAL: "p@ss=word,x"');
  });

  it("fails without calling kubectl when the file is missing", async () => {
    const c = k8s();
    const r = await c.upsertConfigMapFromEnvFile("cm", join(tmpdir(), "does-not-exist.env"), "ns");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read");
    expect(c.manifests).toHaveLength(0);
  });
});
