import { describe, it, expect } from "bun:test";
import { parseHelmList, helmReleaseFromAnnotations, redactValues, buildUpgradeArgs, getValuesArgs, listArgs } from "./helm.ts";

describe("parseHelmList", () => {
  it("parses helm list -o json", () => {
    const json = JSON.stringify([
      { name: "api", namespace: "prod", revision: "3", status: "deployed", chart: "api-1.4.0", app_version: "1.4.0" },
    ]);
    expect(parseHelmList(json)).toEqual([
      { name: "api", namespace: "prod", chart: "api-1.4.0", appVersion: "1.4.0", revision: 3, status: "deployed" },
    ]);
  });

  it("tolerates a numeric revision and missing optional fields", () => {
    expect(parseHelmList(JSON.stringify([{ name: "x", revision: 2 }]))[0]).toMatchObject({ name: "x", revision: 2, chart: "", namespace: "" });
  });

  it("returns [] on malformed input", () => {
    expect(parseHelmList("not json")).toEqual([]);
    expect(parseHelmList("{}")).toEqual([]);
    expect(parseHelmList("[1, 2]")).toEqual([]);
  });
});

describe("helmReleaseFromAnnotations", () => {
  it("resolves the release from the standard annotations", () => {
    expect(
      helmReleaseFromAnnotations({ "meta.helm.sh/release-name": "api", "meta.helm.sh/release-namespace": "prod" }),
    ).toEqual({ name: "api", namespace: "prod" });
  });

  it("is null when either annotation is absent", () => {
    expect(helmReleaseFromAnnotations({ "meta.helm.sh/release-name": "api" })).toBeNull();
    expect(helmReleaseFromAnnotations({ "meta.helm.sh/release-namespace": "prod" })).toBeNull();
    expect(helmReleaseFromAnnotations(null)).toBeNull();
    expect(helmReleaseFromAnnotations({})).toBeNull();
  });
});

describe("redactValues", () => {
  it("redacts sensitive keys and top-level secret blocks, recursively", () => {
    const out = redactValues({
      image: { repository: "acme/api", tag: "v1" },
      dbPassword: "hunter2",
      apiKey: "abc",
      auth: { token: "t", clientId: "ok" },
      secrets: { anything: "x" },
      credentials: { user: "u" },
      replicas: 3,
    }) as Record<string, any>;
    expect(out.image).toEqual({ repository: "acme/api", tag: "v1" }); // untouched
    expect(out.dbPassword).toBe("***");
    expect(out.apiKey).toBe("***");
    expect(out.auth.token).toBe("***");
    expect(out.auth.clientId).toBe("ok");
    expect(out.secrets).toBe("***"); // whole top-level block
    expect(out.credentials).toBe("***");
    expect(out.replicas).toBe(3);
  });

  it("redacts a nested key matching the pattern but leaves unrelated nested keys", () => {
    const out = redactValues({ config: { secrets: { x: 1 }, database: { host: "db" } } }) as any;
    expect(out.config.secrets).toBe("***"); // 'secrets' matches /secret/ at any depth
    expect(out.config.database).toEqual({ host: "db" }); // unrelated nested key untouched
  });

  it("redacts plural *Keys, nested credentials, and other secret-shaped keys (review fixes)", () => {
    const out = redactValues({
      apiKeys: { prod: "sk-live-abc" },
      sshKeys: ["k1"],
      config: { credentials: { dbPass: "hunter2" } }, // nested credentials
      passphrase: "p",
      keystore: "ks",
      jwt: "j",
      accessKey: "ak",
      label: "ok",
    }) as Record<string, unknown>;
    expect(out.apiKeys).toBe("***");
    expect(out.sshKeys).toBe("***");
    expect((out.config as any).credentials).toBe("***"); // nested credential block
    expect(out.passphrase).toBe("***");
    expect(out.keystore).toBe("***");
    expect(out.jwt).toBe("***");
    expect(out.accessKey).toBe("***");
    expect(out.label).toBe("ok");
  });

  it("redacts a string VALUE that embeds an inline credential regardless of key name", () => {
    const out = redactValues({ databaseUrl: "postgres://app:s3cr3t@db:5432/app", homepage: "https://example.com" }) as Record<string, unknown>;
    expect(out.databaseUrl).toBe("***"); // user:pass@ in the DSN
    expect(out.homepage).toBe("https://example.com"); // no embedded credential → kept
  });
});

describe("argv builders", () => {
  it("builds an upgrade with the configured value path (no image.tag heuristic)", () => {
    expect(buildUpgradeArgs("api", "bitnami/nginx", "prod", "app.image.tag", "v2.0.0")).toEqual([
      "upgrade", "api", "bitnami/nginx", "-n", "prod", "--reuse-values", "--set", "app.image.tag=v2.0.0", "--wait", "--timeout", "180s",
    ]);
  });

  it("builds get-values and list argv", () => {
    expect(getValuesArgs("api", "prod")).toEqual(["get", "values", "api", "-n", "prod", "-o", "json"]);
    expect(listArgs("prod")).toEqual(["list", "-n", "prod", "-o", "json"]);
  });
});
