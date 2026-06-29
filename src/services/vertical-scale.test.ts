import { describe, it, expect } from "bun:test";
import { buildResourcesPatch, validateResources, parseQuantity, type ResourcesPatchInput } from "./vertical-scale.ts";

describe("parseQuantity", () => {
  it.each([
    ["100m", 100],
    ["1", 1000],
    ["2", 2000],
    ["0.5", 500],
    ["250m", 250],
  ])("CPU '%s' → %d millicores", (raw, ms) => expect(parseQuantity(raw, "cpu")).toBe(ms));

  it.each([
    ["128Mi", 128 * 1024 * 1024],
    ["1Gi", 1024 * 1024 * 1024],
    ["1G", 1_000_000_000],
    ["512M", 512_000_000],
    ["1024Ki", 1024 * 1024],
  ])("memory '%s' → %d bytes", (raw, bytes) => expect(parseQuantity(raw, "memory")).toBe(bytes));

  it("returns null for unparseable values (never throws)", () => {
    expect(parseQuantity("", "cpu")).toBeNull();
    expect(parseQuantity("garbage", "memory")).toBeNull();
    expect(parseQuantity("1Yi", "memory")).toBeNull();
  });
});

describe("validateResources", () => {
  it("accepts a well-formed request/limit pair", () => {
    expect(
      validateResources({ requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "500m", memory: "512Mi" } }),
    ).toBeNull();
  });

  it("rejects when CPU limit < request", () => {
    const err = validateResources({ requests: { cpu: "500m" }, limits: { cpu: "200m" } });
    expect(err).toMatch(/limit.*cpu/i);
  });

  it("rejects when memory limit < request", () => {
    const err = validateResources({ requests: { memory: "512Mi" }, limits: { memory: "256Mi" } });
    expect(err).toMatch(/limit.*memory/i);
  });

  it("rejects negative or zero requests", () => {
    expect(validateResources({ requests: { cpu: "0" } })).toMatch(/cpu/i);
    expect(validateResources({ requests: { memory: "0" } })).toMatch(/memory/i);
  });

  it("rejects values outside the conservative production caps", () => {
    expect(validateResources({ requests: { cpu: "256" } })).toMatch(/cpu/i); // 256 cores would be a typo
    expect(validateResources({ requests: { memory: "10Ti" } })).toMatch(/memory/i);
  });
});

describe("buildResourcesPatch", () => {
  const baseInput: ResourcesPatchInput = {
    containerName: "app",
    requests: { cpu: "500m", memory: "512Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  };

  it("emits a strategic-merge patch keyed by container name", () => {
    const patch = buildResourcesPatch(baseInput);
    expect(patch.spec.template.spec.containers).toEqual([
      {
        name: "app",
        resources: {
          requests: { cpu: "500m", memory: "512Mi" },
          limits: { cpu: "1", memory: "1Gi" },
        },
      },
    ]);
  });

  it("includes only the keys actually provided (preserves the other side of the spec)", () => {
    const patch = buildResourcesPatch({ containerName: "app", requests: { cpu: "250m" } });
    expect(patch.spec.template.spec.containers[0]!.resources).toEqual({ requests: { cpu: "250m" } });
  });

  it("supports ephemeral-storage for disk-heavy workloads", () => {
    const patch = buildResourcesPatch({
      containerName: "app",
      requests: { "ephemeral-storage": "5Gi" },
    });
    expect(patch.spec.template.spec.containers[0]!.resources.requests).toEqual({ "ephemeral-storage": "5Gi" });
  });
});
