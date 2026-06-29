import { describe, it, expect } from "bun:test";
import { classifyScaling, type ScalingInput } from "./scaling-capability.ts";

function base(overrides: Partial<ScalingInput> = {}): ScalingInput {
  return {
    kind: "Deployment",
    containers: [{ name: "app", image: "nginx:1.27", ports: [{ containerPort: 80 }] }],
    volumes: [],
    pvcs: [],
    storageClasses: [],
    replicas: 1,
    ...overrides,
  };
}

describe("classifyScaling — kind rules", () => {
  it("Deployment with no PVCs and a non-DB image → horizontal + vertical", () => {
    const c = classifyScaling(base());
    expect(c.horizontal).toBe(true);
    expect(c.vertical).toBe(true);
  });

  it("StatefulSet → vertical only (replica scaling is stateful, ordinals matter)", () => {
    const c = classifyScaling(base({ kind: "StatefulSet" }));
    expect(c.horizontal).toBe(false);
    expect(c.vertical).toBe(true);
    expect(c.reasons.some((r) => /StatefulSet/i.test(r))).toBe(true);
  });

  it("DaemonSet → vertical only (one pod per node by definition)", () => {
    const c = classifyScaling(base({ kind: "DaemonSet" }));
    expect(c.horizontal).toBe(false);
    expect(c.vertical).toBe(true);
    expect(c.reasons.some((r) => /DaemonSet/i.test(r))).toBe(true);
  });
});

describe("classifyScaling — PVC rules", () => {
  it("Deployment mounting an RWO PVC → vertical only (multi-writer impossible)", () => {
    const c = classifyScaling(
      base({
        volumes: [{ name: "data", persistentVolumeClaim: { claimName: "pg-data" } }],
        pvcs: [{ name: "pg-data", storageClass: "standard", accessModes: ["ReadWriteOnce"], requested: "10Gi" }],
      }),
    );
    expect(c.horizontal).toBe(false);
    expect(c.vertical).toBe(true);
    expect(c.reasons.some((r) => /ReadWriteOnce/i.test(r))).toBe(true);
  });

  it("Deployment mounting an RWX (ReadWriteMany) PVC → horizontal allowed", () => {
    const c = classifyScaling(
      base({
        volumes: [{ name: "shared", persistentVolumeClaim: { claimName: "shared-data" } }],
        pvcs: [{ name: "shared-data", storageClass: "nfs", accessModes: ["ReadWriteMany"], requested: "50Gi" }],
      }),
    );
    expect(c.horizontal).toBe(true);
    expect(c.vertical).toBe(true);
  });

  it("Surfaces PVC expandability based on storageClass.allowVolumeExpansion", () => {
    const c = classifyScaling(
      base({
        pvcs: [
          { name: "a", storageClass: "fast", accessModes: ["ReadWriteOnce"], requested: "10Gi" },
          { name: "b", storageClass: "frozen", accessModes: ["ReadWriteOnce"], requested: "10Gi" },
        ],
        storageClasses: [
          { name: "fast", allowVolumeExpansion: true },
          { name: "frozen", allowVolumeExpansion: false },
        ],
      }),
    );
    expect(c.pvcs.find((p) => p.name === "a")!.expandable).toBe(true);
    expect(c.pvcs.find((p) => p.name === "b")!.expandable).toBe(false);
  });

  it("Unknown storageClass → expandable=null (treat as unknown, never as true)", () => {
    const c = classifyScaling(
      base({
        pvcs: [{ name: "a", storageClass: "mystery", accessModes: ["ReadWriteOnce"], requested: "5Gi" }],
        storageClasses: [],
      }),
    );
    expect(c.pvcs[0]!.expandable).toBeNull();
  });
});

describe("classifyScaling — known stateful DB images", () => {
  it.each([
    ["postgres:16", true],
    ["docker.io/library/postgres:15-alpine", true],
    ["mysql:8.4", true],
    ["mariadb:11", true],
    ["mongo:7", true],
    ["mongodb/mongodb-community-server:7.0", true],
    ["mcr.microsoft.com/mssql/server:2022-latest", true],
    ["redis:7", true],
    ["rabbitmq:3-management", false], // queue, not a single-instance DB
    ["nginx:1.27", false],
    ["traefik:v3.1", false],
    ["my-registry.example.com/my-app:1.0", false],
  ])("image '%s' → stateful=%s", (image, expectedStateful) => {
    const c = classifyScaling(base({ containers: [{ name: "x", image, ports: [] }] }));
    if (expectedStateful) {
      expect(c.horizontal).toBe(false);
      expect(c.reasons.some((r) => /stateful|database|single-instance/i.test(r))).toBe(true);
    } else {
      expect(c.horizontal).toBe(true);
    }
  });
});

describe("classifyScaling — port heuristic", () => {
  it("a Deployment exposing 5432 with no other signals is still flagged as a DB", () => {
    const c = classifyScaling(
      base({
        containers: [{ name: "db", image: "my-org/postgres-clone:1.0", ports: [{ containerPort: 5432 }] }],
      }),
    );
    expect(c.horizontal).toBe(false);
    expect(c.reasons.some((r) => /5432|postgres/i.test(r))).toBe(true);
  });

  it("exposing a non-DB port (80, 8080, 3000) does not trigger the heuristic", () => {
    expect(classifyScaling(base({ containers: [{ name: "x", image: "x", ports: [{ containerPort: 80 }] }] })).horizontal).toBe(true);
    expect(classifyScaling(base({ containers: [{ name: "x", image: "x", ports: [{ containerPort: 3000 }] }] })).horizontal).toBe(true);
  });
});

describe("classifyScaling — resource snapshot", () => {
  it("returns the current resource requests so the UI can compute the next step", () => {
    const c = classifyScaling(
      base({
        containers: [
          {
            name: "app",
            image: "nginx",
            ports: [{ containerPort: 80 }],
            resources: { requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "1Gi" }, limits: { cpu: "500m", memory: "512Mi" } },
          },
        ],
      }),
    );
    expect(c.resources.requests).toEqual({ cpu: "250m", memory: "256Mi", "ephemeral-storage": "1Gi" });
    expect(c.resources.limits).toEqual({ cpu: "500m", memory: "512Mi" });
  });

  it("returns empty when the workload has no resources block", () => {
    const c = classifyScaling(base());
    expect(c.resources.requests).toEqual({});
    expect(c.resources.limits).toEqual({});
  });
});
