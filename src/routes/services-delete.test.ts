import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  seedRegistryService(deps, { name: "api" });
  seedRegistryService(deps, { name: "other" }); // sibling, must remain untouched
  return deps;
}

describe("DELETE /api/services/:name (purge)", () => {
  it("purges the workload, service, configmap, secret, hpa and removes the registry row", async () => {
    const deleteCalls: string[][] = [];
    const workloadDeletes: Array<[string, string, string]> = [];
    const deps = setup({
      k8s: {
        deleteWorkload: async (kind: string, name: string, ns: string) => {
          workloadDeletes.push([kind, name, ns]);
          return { code: 0, stdout: "", stderr: "" };
        },
        kubectl: async (args: string[]) => {
          if (args.includes("delete")) deleteCalls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
        listIngressesFor: async () => [],
      } as never,
    });

    const r = await call(buildApp(deps), "DELETE", "/api/services/api");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.purge.removed).toContain("Deployment/api");
    expect(r.body.purge.removed).toContain("Service/api");
    expect(r.body.purge.removed).toContain("ConfigMap/api-config");
    expect(r.body.purge.removed).toContain("Secret/api-secret");
    expect(r.body.purge.removed).toContain("HPA/api");
    // Registry row gone.
    expect(deps.registry.get("api")).toBeNull();
    // Other service is untouched.
    expect(deps.registry.get("other")).toBeDefined();
    const otherWorkloadDeletes = workloadDeletes.filter(([_k, n]) => n.startsWith("other"));
    expect(otherWorkloadDeletes).toEqual([]);
  });

  it("deletes the service's env files under envFilesDir but leaves sibling services alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "del-env-"));
    mkdirSync(join(root, "api"), { recursive: true });
    writeFileSync(join(root, "api", "config.env"), "X=1");
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "other", "config.env"), "Y=2");

    const deps = setup({
      envFilesDir: root,
      k8s: {
        deleteWorkload: async () => ({ code: 0, stdout: "", stderr: "" }),
        kubectl: async () => ({ code: 0, stdout: "", stderr: "" }),
        listIngressesFor: async () => [],
      } as never,
    });

    const r = await call(buildApp(deps), "DELETE", "/api/services/api");
    expect(r.status).toBe(200);
    expect(existsSync(join(root, "api"))).toBe(false);
    expect(existsSync(join(root, "other"))).toBe(true);
  });

  it("?dryRun=true reports the plan without touching the cluster or removing the registry row", async () => {
    let deletes = 0;
    const deps = setup({
      k8s: {
        deleteWorkload: async () => {
          deletes++;
          return { code: 0, stdout: "", stderr: "" };
        },
        kubectl: async (args: string[]) => {
          if (args.includes("delete")) deletes++;
          return { code: 0, stdout: "", stderr: "" };
        },
        listIngressesFor: async () => [],
      } as never,
    });
    const r = await call(buildApp(deps), "DELETE", "/api/services/api?dryRun=true");
    expect(r.status).toBe(200);
    expect(deletes).toBe(0);
    expect(r.body.purge.planned.length).toBeGreaterThan(0);
    expect(deps.registry.get("api")).toBeDefined(); // not removed in dry-run
  });

  it("404 when the service is not registered", async () => {
    const deps = setup();
    const r = await call(buildApp(deps), "DELETE", "/api/services/ghost");
    expect(r.status).toBe(404);
  });

  it("still removes the registry row when one cluster-side delete fails (best-effort)", async () => {
    const deps = setup({
      k8s: {
        deleteWorkload: async () => ({ code: 0, stdout: "", stderr: "" }),
        kubectl: async (args: string[]) => {
          if (args.includes("delete") && args.includes("hpa")) {
            return { code: 1, stdout: "", stderr: "Forbidden" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        listIngressesFor: async () => [],
      } as never,
    });
    const r = await call(buildApp(deps), "DELETE", "/api/services/api");
    expect(r.status).toBe(200);
    expect(r.body.purge.failed.length).toBeGreaterThan(0);
    expect(deps.registry.get("api")).toBeNull();
  });

  it("a viewer cannot delete (403) — admin-only mutation", async () => {
    const deps = setup();
    // The auth guard reads the role: GET would be allowed; DELETE goes through requiredRole which
    // demotes to operator. We sign in as a viewer to confirm the negative path holds.
    const { signJwt } = await import("../lib/jwt.ts");
    const { TEST_JWT_SECRET } = await import("./test-fakes.ts");
    const token = await signJwt({ sub: "u-viewer", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    const r = await call(buildApp(deps), "DELETE", "/api/services/api", undefined, {
      auth: false,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
  });
});
