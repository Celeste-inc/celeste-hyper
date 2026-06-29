import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

async function setup(over: FakeDepsOptions = {}, refresh = true) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  seedRegistryService(deps);
  if (refresh) await deps.capabilities.refreshCluster("primary");
  return deps;
}

const topPodsStdout = [
  "hello-7d8b5c4f5-abc12   25m    64Mi",
  "hello-7d8b5c4f5-def34   100m   128Mi",
].join("\n");

describe("metrics route", () => {
  it("GET /api/services/:name/metrics returns pod CPU/RAM + summary", async () => {
    const deps = await setup({
      k8s: {
        getWorkloadSelector: async () => "app=hello",
        kubectl: async (args) => {
          // capability probe path uses api-versions; the route uses `top pods` with selector
          if (args.includes("api-versions")) {
            return { code: 0, stdout: "v1\napps/v1\nautoscaling/v2\nmetrics.k8s.io/v1beta1", stderr: "" };
          }
          if (args[2] === "top" && args[3] === "pods") {
            return { code: 0, stdout: topPodsStdout, stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/metrics");
    expect(r.status).toBe(200);
    expect(r.body.pods).toHaveLength(2);
    expect(r.body.pods[0]).toMatchObject({ pod: "hello-7d8b5c4f5-abc12", cpuMillicores: 25, memoryMi: 64 });
    expect(r.body.summary).toMatchObject({
      podCount: 2,
      totalCpuMillicores: 125,
      totalMemoryMi: 192,
    });
  });

  it("scopes the `kubectl top pods` call to the service's namespace and selector", async () => {
    const calls: string[][] = [];
    const deps = await setup({
      k8s: {
        getWorkloadSelector: async () => "app=hello",
        kubectl: async (args) => {
          calls.push(args);
          if (args.includes("api-versions")) {
            return { code: 0, stdout: "v1\napps/v1\nmetrics.k8s.io/v1beta1", stderr: "" };
          }
          if (args[2] === "top" && args[3] === "pods") {
            return { code: 0, stdout: topPodsStdout, stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/metrics");
    expect(r.status).toBe(200);
    const top = calls.find((c) => c[2] === "top" && c[3] === "pods");
    expect(top).toBeDefined();
    expect(top!.slice(0, 2)).toEqual(["-n", "default"]);
    expect(top).toContain("-l");
    expect(top).toContain("app=hello");
    expect(top).toContain("--no-headers");
  });

  it("returns 409 when the cluster lacks metrics-server", async () => {
    const deps = await setup(
      {
        k8s: {
          getWorkloadSelector: async () => "app=hello",
          kubectl: async () => ({ code: 0, stdout: "v1\napps/v1", stderr: "" }),
        },
      },
      false,
    );
    const r = await call(buildApp(deps), "GET", "/api/services/hello/metrics");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("metrics");
  });

  it("returns 404 when the service is unknown", async () => {
    const deps = await setup();
    const r = await call(buildApp(deps), "GET", "/api/services/ghost/metrics");
    expect(r.status).toBe(404);
  });

  it("502s when kubectl top fails (e.g. metrics-server scraping error)", async () => {
    const deps = await setup({
      k8s: {
        getWorkloadSelector: async () => "app=hello",
        kubectl: async (args) => {
          if (args.includes("api-versions")) {
            return { code: 0, stdout: "v1\napps/v1\nmetrics.k8s.io/v1beta1", stderr: "" };
          }
          if (args[2] === "top" && args[3] === "pods") {
            return { code: 1, stdout: "", stderr: "metrics not available yet" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/metrics");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("metrics not available");
  });

  it("returns an empty pod list (and zero summary) when the service has no pods scheduled yet", async () => {
    const deps = await setup({
      k8s: {
        getWorkloadSelector: async () => "app=hello",
        kubectl: async (args) => {
          if (args.includes("api-versions")) {
            return { code: 0, stdout: "v1\napps/v1\nmetrics.k8s.io/v1beta1", stderr: "" };
          }
          if (args[2] === "top" && args[3] === "pods") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    const r = await call(buildApp(deps), "GET", "/api/services/hello/metrics");
    expect(r.status).toBe(200);
    expect(r.body.pods).toEqual([]);
    expect(r.body.summary).toMatchObject({ podCount: 0, totalCpuMillicores: 0, totalMemoryMi: 0 });
  });
});
