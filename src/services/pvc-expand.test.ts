import { describe, it, expect } from "bun:test";
import { buildPvcExpandPatch, validatePvcExpand } from "./pvc-expand.ts";

describe("validatePvcExpand", () => {
  it("accepts a strictly larger value with a matching unit", () => {
    expect(validatePvcExpand({ from: "10Gi", to: "20Gi" })).toBeNull();
    expect(validatePvcExpand({ from: "10Gi", to: "11Gi" })).toBeNull();
  });

  it("rejects shrinking (k8s PVCs cannot shrink online)", () => {
    expect(validatePvcExpand({ from: "20Gi", to: "10Gi" })).toMatch(/shrink|smaller/i);
    expect(validatePvcExpand({ from: "20Gi", to: "20Gi" })).toMatch(/larger/i);
  });

  it("rejects when the StorageClass does not allow expansion", () => {
    expect(validatePvcExpand({ from: "10Gi", to: "20Gi", expandable: false })).toMatch(/allowVolumeExpansion|StorageClass/i);
  });

  it("allows null expandable (unknown StorageClass) — defers the call to kubectl, which surfaces the real error", () => {
    expect(validatePvcExpand({ from: "10Gi", to: "20Gi", expandable: null })).toBeNull();
  });

  it("rejects an unparseable target value (junk input)", () => {
    expect(validatePvcExpand({ from: "10Gi", to: "lots" })).toMatch(/value/i);
  });

  it("rejects sizes above the conservative safety cap (4Ti per PVC)", () => {
    expect(validatePvcExpand({ from: "10Gi", to: "8Ti" })).toMatch(/cap|safety|maximum/i);
  });
});

describe("buildPvcExpandPatch", () => {
  it("patches spec.resources.requests.storage with the new size", () => {
    expect(buildPvcExpandPatch("50Gi")).toEqual({
      spec: { resources: { requests: { storage: "50Gi" } } },
    });
  });
});
