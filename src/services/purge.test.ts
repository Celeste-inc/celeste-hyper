import { describe, it, expect } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceModel } from "./model.ts";
import { purgeService, type PurgeK8s } from "./purge.ts";

function svc(over: Partial<ServiceModel> = {}): ServiceModel {
  return {
    sourceType: "registry-pull",
    name: "api",
    namespace: "default",
    clusterId: "primary",
    imageRef: "ghcr.io/acme/api",
    workloadKind: "Deployment",
    enabled: true,
    ...over,
  } as ServiceModel;
}

interface Spy {
  deleteWorkload: Array<[string, string, string]>;
  kubectl: string[][];
  listIngressesFor: Array<[string, string]>;
  /** Names returned by listIngressesFor on the next call (drained as a queue). */
  ingressesQueue: Array<Array<{ ingressName: string; host: string; path: string; tls: boolean }>>;
  /** Forces the next `kubectl <verb>` call to fail (returns this stderr). */
  forceFail?: { match: (args: string[]) => boolean; stderr: string };
}

function fakeK8s(opts: Partial<Spy> = {}): { k8s: PurgeK8s; calls: Spy } {
  const calls: Spy = {
    deleteWorkload: [],
    kubectl: [],
    listIngressesFor: [],
    ingressesQueue: opts.ingressesQueue ?? [],
    forceFail: opts.forceFail,
  };
  const k8s: PurgeK8s = {
    async deleteWorkload(kind, name, namespace) {
      calls.deleteWorkload.push([kind, name, namespace]);
      return { code: 0, stdout: "", stderr: "" };
    },
    async kubectl(args) {
      calls.kubectl.push(args);
      if (calls.forceFail?.match(args)) return { code: 1, stdout: "", stderr: calls.forceFail.stderr };
      return { code: 0, stdout: "", stderr: "" };
    },
    async listIngressesFor(svcName, namespace) {
      calls.listIngressesFor.push([svcName, namespace]);
      return calls.ingressesQueue.shift() ?? [];
    },
  };
  return { k8s, calls };
}

describe("purgeService", () => {
  it("deletes the primary workload by kind+name+namespace", async () => {
    const { k8s, calls } = fakeK8s();
    const result = await purgeService(svc(), { k8s });
    expect(calls.deleteWorkload).toContainEqual(["Deployment", "api", "default"]);
    expect(result.removed).toContain("Deployment/api");
  });

  it("deletes the Service object matching the workload (idempotent — uses --ignore-not-found)", async () => {
    const { k8s, calls } = fakeK8s();
    await purgeService(svc(), { k8s });
    const deleteSvc = calls.kubectl.find((a) => a[2] === "delete" && a[3] === "service");
    expect(deleteSvc).toBeDefined();
    expect(deleteSvc).toContain("--ignore-not-found");
    expect(deleteSvc).toContain("api");
  });

  it("deletes the config + secret ConfigMap and Secret keyed off the service name", async () => {
    const { k8s, calls } = fakeK8s();
    await purgeService(svc(), { k8s });
    const cm = calls.kubectl.find((a) => a[2] === "delete" && a[3] === "configmap");
    const sec = calls.kubectl.find((a) => a[2] === "delete" && a[3] === "secret");
    expect(cm).toContain("api-config");
    expect(sec).toContain("api-secret");
  });

  it("deletes the HPA targeting this workload (best-effort)", async () => {
    const { k8s, calls } = fakeK8s();
    await purgeService(svc(), { k8s });
    const hpa = calls.kubectl.find((a) => a[2] === "delete" && a[3] === "hpa");
    expect(hpa).toBeDefined();
    expect(hpa).toContain("api");
  });

  it("tears down canary + green leftovers (`<name>-canary`, `<name>-green`)", async () => {
    const { k8s, calls } = fakeK8s();
    await purgeService(svc(), { k8s });
    const names = calls.deleteWorkload.map(([_, n]) => n);
    expect(names).toContain("api-canary");
    expect(names).toContain("api-green");
  });

  it("deletes Ingress objects that reference this service's Service", async () => {
    const { k8s, calls } = fakeK8s({
      ingressesQueue: [[
        { ingressName: "api-public", host: "api.example.com", path: "/", tls: true },
        { ingressName: "api-internal", host: "api.internal", path: "/", tls: false },
      ]],
    });
    await purgeService(svc(), { k8s });
    const deletedIngresses = calls.kubectl
      .filter((a) => a[2] === "delete" && a[3] === "ingress")
      .flatMap((a) => a.filter((p, i) => i >= 4 && !p.startsWith("--")));
    expect(deletedIngresses).toContain("api-public");
    expect(deletedIngresses).toContain("api-internal");
  });

  it("also deletes related-workload objects when declared on the spec", async () => {
    const s = svc({ relatedWorkloads: [{ kind: "DaemonSet", name: "api-worker" }] });
    const { k8s, calls } = fakeK8s();
    await purgeService(s, { k8s });
    expect(calls.deleteWorkload).toContainEqual(["DaemonSet", "api-worker", "default"]);
  });

  it("removes the env-files directory for the service if envFilesDir is provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "purge-env-"));
    mkdirSync(join(root, "api"), { recursive: true });
    writeFileSync(join(root, "api", "config.env"), "PORT=8080");
    writeFileSync(join(root, "api", "secret.env"), "TOKEN=abc");
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "other", "config.env"), "X=1");

    const { k8s } = fakeK8s();
    const result = await purgeService(svc(), { k8s, envFilesDir: root });
    expect(existsSync(join(root, "api"))).toBe(false);
    expect(existsSync(join(root, "other"))).toBe(true); // other services untouched
    expect(result.removed.some((r) => r.startsWith("envFiles/"))).toBe(true);
  });

  it("collects every step as either removed or failed — and never throws", async () => {
    const { k8s } = fakeK8s({
      forceFail: { match: (args) => args[2] === "delete" && args[3] === "hpa", stderr: "Forbidden" },
    });
    const result = await purgeService(svc(), { k8s });
    expect(result.failed.find((f) => f.resource.startsWith("HPA"))).toBeDefined();
    // Other steps still ran.
    expect(result.removed.some((r) => r.startsWith("Deployment/"))).toBe(true);
  });

  it("dryRun: reports what WOULD be removed but performs no mutation", async () => {
    const { k8s, calls } = fakeK8s();
    const result = await purgeService(svc(), { k8s, dryRun: true });
    expect(calls.deleteWorkload).toEqual([]);
    expect(calls.kubectl.every((a) => a[0] !== "delete")).toBe(true);
    expect(result.planned.length).toBeGreaterThan(0);
    expect(result.removed).toEqual([]);
  });
});
