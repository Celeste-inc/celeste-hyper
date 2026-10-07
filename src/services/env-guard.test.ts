import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crossKindDuplicates, digestValues, evaluateDrift, loadDigestKey, readLiveEnv } from "./env-guard.ts";

const KEY = Buffer.alloc(32, 7);
const digest = (values: Record<string, string>) => digestValues(KEY, "svc", "config", values);

describe("crossKindDuplicates", () => {
  it("returns sorted keys defined in both files", () => {
    expect(crossKindDuplicates({ B: "1", A: "2", ONLY_CONFIG: "x" }, { A: "s", B: "t", ONLY_SECRET: "y" })).toEqual(["A", "B"]);
    expect(crossKindDuplicates({ A: "1" }, {})).toEqual([]);
  });
});

describe("digestValues", () => {
  it("is keyed, deterministic and scoped by service, kind and key", () => {
    const base = digestValues(KEY, "svc", "config", { DB: "prod" });
    expect(base.DB).toMatch(/^[0-9a-f]{64}$/);
    expect(base.DB).not.toContain("prod");
    expect(digestValues(KEY, "svc", "config", { DB: "prod" }).DB).toBe(base.DB);
    expect(digestValues(KEY, "other", "config", { DB: "prod" }).DB).not.toBe(base.DB);
    expect(digestValues(KEY, "svc", "secret", { DB: "prod" }).DB).not.toBe(base.DB);
    expect(digestValues(Buffer.alloc(32, 8), "svc", "config", { DB: "prod" }).DB).not.toBe(base.DB);
  });
});

describe("evaluateDrift", () => {
  const applied = digest({ DB: "prod", SHARE: "records", KEEP: "1" });

  it("blocks keys changed in the cluster that the deploy would revert", () => {
    const live = digest({ DB: "prod_hotfix", SHARE: "records", KEEP: "1" });
    const rendered = digest({ DB: "prod", SHARE: "records", KEEP: "1" });
    expect(evaluateDrift(rendered, live, applied)).toEqual({ blocked: ["DB"], warnings: [] });
  });

  it("allows keys intentionally changed through hyper", () => {
    const live = digest({ DB: "prod_hotfix", SHARE: "records", KEEP: "1" });
    const rendered = digest({ DB: "prod_new", SHARE: "records", KEEP: "1" });
    expect(evaluateDrift(rendered, live, applied).blocked).toEqual([]);
  });

  it("blocks a key deleted from the cluster that the deploy would restore", () => {
    const live = digest({ SHARE: "records", KEEP: "1" });
    expect(evaluateDrift(applied, live, applied).blocked).toEqual(["DB"]);
  });

  it("passes when the cluster still holds what hyper applied", () => {
    expect(evaluateDrift(digest({ DB: "prod", SHARE: "acd_c", KEEP: "1" }), applied, applied)).toEqual({ blocked: [], warnings: [] });
  });

  it("only warns without a baseline and names the differing keys", () => {
    const live = digest({ DB: "prod", SHARE: "records" });
    const rendered = digest({ DB: "old", SHARE: "acd_c", NEW: "x" });
    const report = evaluateDrift(rendered, live, null);
    expect(report.blocked).toEqual([]);
    expect(report.warnings).toEqual(["no applied baseline; values differ from the cluster: DB, SHARE"]);
  });

  it("warns about keys that exist only in the cluster", () => {
    const live = digest({ DB: "prod", SHARE: "records", KEEP: "1", MANUAL: "x" });
    expect(evaluateDrift(applied, live, applied).warnings).toEqual(["keys present only in the cluster: MANUAL"]);
  });

  it("does nothing when the live object does not exist yet", () => {
    expect(evaluateDrift(applied, null, applied)).toEqual({ blocked: [], warnings: [] });
  });
});

describe("loadDigestKey", () => {
  it("creates a 0600 key once and reuses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyper-digest-"));
    const first = loadDigestKey(dir);
    const second = loadDigestKey(dir);
    expect(first.length).toBe(32);
    expect(second.equals(first)).toBe(true);
    expect(readFileSync(join(dir, "env-digest.key"), "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, "env-digest.key")).mode & 0o777).toBe(0o600);
  });

  it("rejects a corrupted key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyper-digest-"));
    writeFileSync(join(dir, "env-digest.key"), "abc");
    expect(() => loadDigestKey(dir)).toThrow("32 hex-encoded bytes");
  });
});

describe("readLiveEnv", () => {
  const k8s = (result: { code: number; stdout?: string; stderr?: string }) => ({
    kubectl: async () => ({ stdout: "", stderr: "", ...result }),
  }) as never;

  it("decodes secret data and returns configmap data verbatim", async () => {
    const secret = await readLiveEnv(k8s({ code: 0, stdout: JSON.stringify({ data: { PASS: Buffer.from("s3cr3t").toString("base64") } }) }), "secret", "svc-secret", "ns");
    expect(secret).toEqual({ ok: true, values: { PASS: "s3cr3t" } });
    const config = await readLiveEnv(k8s({ code: 0, stdout: JSON.stringify({ data: { DB: "prod" } }) }), "config", "svc-config", "ns");
    expect(config).toEqual({ ok: true, values: { DB: "prod" } });
  });

  it("treats NotFound as a missing object and other failures as errors", async () => {
    expect(await readLiveEnv(k8s({ code: 1, stderr: 'Error from server (NotFound): secrets "x" not found' }), "secret", "x", "ns")).toEqual({ ok: true, values: null });
    const failed = await readLiveEnv(k8s({ code: 1, stderr: "Unable to connect to the server" }), "config", "x", "ns");
    expect(failed.ok).toBe(false);
    expect((await readLiveEnv(k8s({ code: 0, stdout: "not json" }), "config", "x", "ns")).ok).toBe(false);
  });
});
