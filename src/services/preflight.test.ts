import { describe, it, expect } from "bun:test";
import type { RunResult } from "../lib/k8s.ts";
import type { K8sLike } from "../lib/k8s-port.ts";
import type { ServiceModel } from "./model.ts";
import { preflightSetImage } from "./preflight.ts";

function k8s(impl: (args: string[]) => RunResult): K8sLike {
  return { kubectl: async (a: string[]) => impl(a) } as unknown as K8sLike;
}

const registrySvc = (over: Partial<ServiceModel> = {}): ServiceModel =>
  ({ sourceType: "registry-pull", name: "api", namespace: "prod", clusterId: "c1", imageRef: "acme/api", workloadKind: "Deployment", enabled: true, ...over } as ServiceModel);

describe("preflightSetImage", () => {
  it("runs a server-side dry-run for registry-pull and reports pass", async () => {
    let seen: string[] = [];
    const res = await preflightSetImage(k8s((a) => ((seen = a), { code: 0, stdout: "deployment.apps/api image updated (server dry run)", stderr: "" })), registrySvc(), "v2.0.0");
    expect(res).toEqual({ applicable: true, ok: true });
    expect(seen).toContain("--dry-run=server");
    expect(seen).toContain("set");
    expect(seen).toContain("api=acme/api:v2.0.0");
    expect(seen).toContain("deployment/api");
    // the workload/container positionals come AFTER the `--` end-of-options separator
    expect(seen.indexOf("--")).toBeLessThan(seen.indexOf("deployment/api"));
  });

  it("surfaces an admission denial as the reason", async () => {
    const denial = 'admission webhook "validate.kyverno.svc" denied the request: image must be signed';
    const res = await preflightSetImage(k8s(() => ({ code: 1, stdout: "", stderr: denial })), registrySvc(), "v2");
    expect(res.applicable).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("denied the request");
  });

  it("is not applicable for r2-bundle / git-sync (no cheap dry-run)", async () => {
    const ran = { called: false };
    const probe = k8s(() => ((ran.called = true), { code: 0, stdout: "", stderr: "" }));
    expect(await preflightSetImage(probe, { sourceType: "r2-bundle", name: "x", namespace: "p", clusterId: "c1", r2Prefix: "x/" } as ServiceModel, "v1")).toEqual({ applicable: false });
    expect(await preflightSetImage(probe, { sourceType: "git-sync", name: "y", namespace: "p", clusterId: "c1", gitUrl: "https://h/r", gitRef: "main", gitPath: "." } as ServiceModel, "v1")).toEqual({ applicable: false });
    expect(ran.called).toBe(false); // never touched the cluster
  });

  it("uses the configured workload/container names and honors a bad tag", async () => {
    let seen: string[] = [];
    await preflightSetImage(k8s((a) => ((seen = a), { code: 0, stdout: "", stderr: "" })), registrySvc({ workloadName: "api-web", containerName: "app", workloadKind: "StatefulSet" }), "v3");
    expect(seen).toContain("statefulset/api-web");
    expect(seen).toContain("app=acme/api:v3");
    // a tag that could be argv-funny is rejected before touching the cluster
    expect(await preflightSetImage(k8s(() => ({ code: 0, stdout: "", stderr: "" })), registrySvc(), "--server=evil")).toMatchObject({ ok: false, reason: "invalid tag" });
  });
});
