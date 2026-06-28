import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";
import type { HelmLike } from "../lib/helm.ts";

const helmAnno = { "meta.helm.sh/release-name": "api", "meta.helm.sh/release-namespace": "prod" };

/** A helm fake that answers list + get-values from the args. */
function fakeHelm(over: { list?: string; values?: string } = {}): HelmLike {
  return {
    run: async (_cluster, args) => {
      if (args[0] === "list") return { code: 0, stdout: over.list ?? JSON.stringify([{ name: "api", namespace: "prod", revision: "2", status: "deployed", chart: "nginx-15.1.0", app_version: "1.25.3" }]), stderr: "" };
      if (args[0] === "get" && args[1] === "values") return { code: 0, stdout: over.values ?? JSON.stringify({ image: { tag: "v1" }, dbPassword: "hunter2" }), stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  };
}

function helmDeps(opts: { annotations?: Record<string, unknown>; helm?: HelmLike; svc?: Record<string, unknown> } = {}) {
  const deps = makeFakeDeps({
    which: (b) => b === "helm", // enable helmCli
    helm: opts.helm ?? fakeHelm(),
    k8s: { getWorkloadJson: async () => ({ code: 0, stdout: JSON.stringify({ metadata: { annotations: opts.annotations ?? {} } }), stderr: "" }) },
  });
  seedCluster(deps);
  seedRegistryService(deps, opts.svc ?? {});
  return deps;
}

describe("helm routes", () => {
  it("GET returns null for a workload that is not Helm-managed", async () => {
    const deps = helmDeps({ annotations: {} });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/helm");
    expect(r.status).toBe(200);
    expect(r.body.helm).toBeNull();
  });

  it("GET returns the release, chart, version, and REDACTED values for a Helm-managed workload", async () => {
    const deps = helmDeps({ annotations: helmAnno, svc: { helmRelease: "api", helmChartRef: "bitnami/nginx", helmImageTagValuePath: "image.tag" } });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/helm");
    expect(r.status).toBe(200);
    expect(r.body.helm).toMatchObject({ release: "api", namespace: "prod", chart: "nginx-15.1.0", version: "1.25.3", upgradeable: true });
    expect(r.body.helm.valuesRedacted.dbPassword).toBe("***"); // secret redacted
    expect(r.body.helm.valuesRedacted.image).toEqual({ tag: "v1" });
  });

  it("GET is 409 when the helmCli capability is absent", async () => {
    const deps = makeFakeDeps(); // no `which` → helmCli false
    seedCluster(deps);
    seedRegistryService(deps);
    const r = await call(buildApp(deps), "GET", "/api/services/hello/helm");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("helmCli");
  });

  it("POST upgrade enqueues a helm-upgrade job for a configured service", async () => {
    const deps = helmDeps({ annotations: helmAnno, svc: { helmRelease: "api", helmChartRef: "bitnami/nginx", helmImageTagValuePath: "app.image.tag" } });
    const r = await call(buildApp(deps), "POST", "/api/services/hello/helm/upgrade", { tag: "v2.0.0" });
    expect(r.status).toBe(202);
    const id = r.body.deploymentId as number;
    expect(deps.queue.getJob(id)!.kind).toBe("helm-upgrade");
    expect(deps.state.deploymentById(id)!.tag).toBe("v2.0.0");
  });

  it("POST upgrade is 422 when the service lacks helm config", async () => {
    const deps = helmDeps({ annotations: helmAnno, svc: {} }); // no helm fields
    const r = await call(buildApp(deps), "POST", "/api/services/hello/helm/upgrade", { tag: "v2" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("helm-not-configured");
  });

  it("POST upgrade rejects an argument-injecting tag (422)", async () => {
    const deps = helmDeps({ annotations: helmAnno, svc: { helmRelease: "api", helmChartRef: "bitnami/nginx", helmImageTagValuePath: "image.tag" } });
    const app = buildApp(deps);
    for (const tag of ["--post-renderer=/tmp/x", "v1,foo=bar", "v1 --set=x", "-v2"]) {
      const r = await call(app, "POST", "/api/services/hello/helm/upgrade", { tag });
      expect(r.status).toBe(422);
    }
  });

  it("POST upgrade is 409 without the helmCli capability", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps, { helmRelease: "api", helmChartRef: "c", helmImageTagValuePath: "image.tag" });
    const r = await call(buildApp(deps), "POST", "/api/services/hello/helm/upgrade", { tag: "v2" });
    expect(r.status).toBe(409);
  });
});
