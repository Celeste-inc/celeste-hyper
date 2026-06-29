import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, type FakeDepsOptions } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

function setup(over: FakeDepsOptions = {}) {
  const deps = makeFakeDeps(over);
  seedCluster(deps);
  seedRegistryService(deps, { name: "api", containerName: "api" });
  return deps;
}

const nginxWorkload = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "api", namespace: "default" },
  spec: {
    replicas: 1,
    template: {
      spec: {
        containers: [{ name: "api", image: "nginx:1.27", ports: [{ containerPort: 80 }], resources: { requests: { cpu: "250m", memory: "256Mi" } } }],
        volumes: [],
      },
    },
  },
};

const postgresWorkload = {
  apiVersion: "apps/v1",
  kind: "StatefulSet",
  metadata: { name: "api", namespace: "default" },
  spec: {
    replicas: 1,
    template: {
      spec: {
        containers: [{ name: "api", image: "postgres:16", ports: [{ containerPort: 5432 }], resources: { requests: { cpu: "500m", memory: "512Mi" } } }],
        volumes: [{ name: "data", persistentVolumeClaim: { claimName: "api-data" } }],
      },
    },
  },
};

function withWorkload(workload: Record<string, unknown>, pvcs: unknown[] = [], storageClasses: unknown[] = []) {
  return async (args: string[]) => {
    if (args[0] === "get" && args[1] === "deployments,statefulsets,daemonsets") {
      return { code: 0, stdout: JSON.stringify({ items: [workload] }), stderr: "" };
    }
    if (args.includes("get") && args.includes("deployment") && args.includes("-o") && args.includes("json")) {
      return { code: 0, stdout: JSON.stringify(workload), stderr: "" };
    }
    if (args.includes("get") && args.includes("statefulset") && args.includes("-o") && args.includes("json")) {
      return { code: 0, stdout: JSON.stringify(workload), stderr: "" };
    }
    if (args.includes("get") && args.includes("pvc") && args.includes("-o") && args.includes("json")) {
      return { code: 0, stdout: JSON.stringify({ items: pvcs }), stderr: "" };
    }
    if (args.includes("get") && args.includes("storageclasses") && args.includes("-o") && args.includes("json")) {
      return { code: 0, stdout: JSON.stringify({ items: storageClasses }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("GET /api/services/:name/scaling-capability", () => {
  it("returns horizontal+vertical=true for a stateless Deployment", async () => {
    const deps = setup({
      k8s: { kubectl: withWorkload(nginxWorkload) } as never,
    });
    const r = await call(buildApp(deps), "GET", "/api/services/api/scaling-capability");
    expect(r.status).toBe(200);
    expect(r.body.horizontal).toBe(true);
    expect(r.body.vertical).toBe(true);
  });

  it("returns horizontal=false with reasons for a StatefulSet running postgres", async () => {
    const deps = setup({
      k8s: {
        kubectl: withWorkload(postgresWorkload, [
          { metadata: { name: "api-data" }, spec: { storageClassName: "standard", accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } } },
        ], [
          { metadata: { name: "standard" }, allowVolumeExpansion: true },
        ]),
      } as never,
    });
    // Override the service so it's a StatefulSet.
    deps.registry.update("api", { workloadKind: "StatefulSet" } as never);
    const r = await call(buildApp(deps), "GET", "/api/services/api/scaling-capability");
    expect(r.status).toBe(200);
    expect(r.body.horizontal).toBe(false);
    expect(r.body.vertical).toBe(true);
    expect(r.body.reasons.some((reason: string) => /StatefulSet|postgres|database/i.test(reason))).toBe(true);
    expect(r.body.pvcs[0]).toMatchObject({ name: "api-data", expandable: true, requested: "10Gi" });
  });
});

describe("PATCH /api/services/:name/resources", () => {
  it("patches the container's resources.requests/limits via strategic-merge", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        kubectl: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/api/resources", {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    });
    expect(r.status).toBe(200);
    const patch = calls.find((a) => a.includes("patch") && (a.includes("deployment") || a.includes("statefulset") || a.includes("daemonset")));
    expect(patch).toBeDefined();
    const body = JSON.parse(patch![patch!.indexOf("-p") + 1]!) as { spec: { template: { spec: { containers: Array<{ resources: { requests: Record<string, string> } }> } } } };
    expect(body.spec.template.spec.containers[0]!.resources.requests).toEqual({ cpu: "500m", memory: "512Mi" });
  });

  it("422 when limit < request", async () => {
    const deps = setup();
    const r = await call(buildApp(deps), "PATCH", "/api/services/api/resources", {
      requests: { cpu: "500m" },
      limits: { cpu: "200m" },
    });
    expect(r.status).toBe(422);
  });

  it("422 when a value exceeds the safety cap", async () => {
    const deps = setup();
    const r = await call(buildApp(deps), "PATCH", "/api/services/api/resources", {
      requests: { cpu: "256" },
    });
    expect(r.status).toBe(422);
  });

  it("a viewer cannot patch resources (operator+)", async () => {
    const { signJwt } = await import("../lib/jwt.ts");
    const { TEST_JWT_SECRET } = await import("./test-fakes.ts");
    const token = await signJwt({ sub: "u-viewer", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    const deps = setup();
    const r = await call(buildApp(deps), "PATCH", "/api/services/api/resources", { requests: { cpu: "250m" } }, {
      auth: false,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
  });
});

describe("PATCH /api/services/:name/pvcs/:pvc", () => {
  it("expands a PVC when its StorageClass allows it", async () => {
    const calls: string[][] = [];
    const deps = setup({
      k8s: {
        kubectl: async (args: string[]) => {
          calls.push(args);
          if (args.includes("get") && args.includes("pvc") && args.includes("-o") && args.includes("json")) {
            return {
              code: 0,
              stdout: JSON.stringify({
                metadata: { name: "api-data" },
                spec: { storageClassName: "standard", accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } },
              }),
              stderr: "",
            };
          }
          if (args.includes("get") && args.includes("storageclass")) {
            return { code: 0, stdout: JSON.stringify({ metadata: { name: "standard" }, allowVolumeExpansion: true }), stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/api/pvcs/api-data", { to: "20Gi" });
    expect(r.status).toBe(200);
    const patch = calls.find((a) => a.includes("patch") && a.includes("pvc"));
    expect(patch).toBeDefined();
    expect(patch).toContain("api-data");
    const body = JSON.parse(patch![patch!.indexOf("-p") + 1]!) as { spec: { resources: { requests: { storage: string } } } };
    expect(body.spec.resources.requests.storage).toBe("20Gi");
  });

  it("422 when shrinking", async () => {
    const deps = setup({
      k8s: {
        kubectl: async (args: string[]) => {
          if (args.includes("get") && args.includes("pvc") && args.includes("-o") && args.includes("json")) {
            return {
              code: 0,
              stdout: JSON.stringify({
                metadata: { name: "api-data" },
                spec: { storageClassName: "standard", accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "20Gi" } } },
              }),
              stderr: "",
            };
          }
          if (args.includes("get") && args.includes("storageclass")) {
            return { code: 0, stdout: JSON.stringify({ metadata: { name: "standard" }, allowVolumeExpansion: true }), stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/api/pvcs/api-data", { to: "10Gi" });
    expect(r.status).toBe(422);
  });

  it("422 when the StorageClass does not allow expansion", async () => {
    const deps = setup({
      k8s: {
        kubectl: async (args: string[]) => {
          if (args.includes("get") && args.includes("pvc") && args.includes("-o") && args.includes("json")) {
            return {
              code: 0,
              stdout: JSON.stringify({
                metadata: { name: "api-data" },
                spec: { storageClassName: "frozen", accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } },
              }),
              stderr: "",
            };
          }
          if (args.includes("get") && args.includes("storageclass")) {
            return { code: 0, stdout: JSON.stringify({ metadata: { name: "frozen" }, allowVolumeExpansion: false }), stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      } as never,
    });
    const r = await call(buildApp(deps), "PATCH", "/api/services/api/pvcs/api-data", { to: "20Gi" });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/allowVolumeExpansion/i);
  });
});
