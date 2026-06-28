import { describe, it, expect } from "bun:test";
import { MIN_KUBECTL, parseKubeMinor, parseKubectlVersion, isClientSupported, evaluateSkew } from "./kube-version.ts";

describe("parseKubeMinor", () => {
  it("parses gitVersion / plain / suffixed forms", () => {
    expect(parseKubeMinor("v1.31.13+k3s1")).toEqual({ major: 1, minor: 31 });
    expect(parseKubeMinor("1.30")).toEqual({ major: 1, minor: 30 });
    expect(parseKubeMinor("v1.30.4-eks-abc")).toEqual({ major: 1, minor: 30 });
  });
  it("returns null for junk / empty", () => {
    expect(parseKubeMinor("")).toBeNull();
    expect(parseKubeMinor(null)).toBeNull();
    expect(parseKubeMinor("not-a-version")).toBeNull();
  });
});

describe("parseKubectlVersion", () => {
  it("extracts client and server gitVersion from `kubectl version -o json`", () => {
    const out = JSON.stringify({ clientVersion: { gitVersion: "v1.31.0" }, serverVersion: { gitVersion: "v1.31.13+k3s1" } });
    expect(parseKubectlVersion(out)).toEqual({ client: "v1.31.0", server: "v1.31.13+k3s1" });
  });
  it("tolerates a client-only payload, non-JSON, and JSON null/array", () => {
    expect(parseKubectlVersion(JSON.stringify({ clientVersion: { gitVersion: "v1.30.0" } }))).toEqual({ client: "v1.30.0", server: null });
    expect(parseKubectlVersion("error: not json")).toEqual({ client: null, server: null });
    expect(parseKubectlVersion("null")).toEqual({ client: null, server: null });
    expect(parseKubectlVersion("[1,2]")).toEqual({ client: null, server: null });
  });
});

describe("isClientSupported", () => {
  it("requires >= the documented minimum (1.30)", () => {
    expect(MIN_KUBECTL).toBe("1.30");
    expect(isClientSupported("v1.30.0")).toBe(true);
    expect(isClientSupported("v1.31.4")).toBe(true);
    expect(isClientSupported("v1.29.9")).toBe(false);
    expect(isClientSupported("v2.0.0")).toBe(true);
  });
  it("does not false-alarm on an unparseable version", () => {
    expect(isClientSupported(null)).toBe(true);
    expect(isClientSupported("weird")).toBe(true);
  });
});

describe("evaluateSkew", () => {
  it("is ok within ±1 minor and at/above the minimum", () => {
    expect(evaluateSkew("v1.31.0", "v1.31.13+k3s1")).toMatchObject({ ok: true, reason: null });
    expect(evaluateSkew("v1.31.0", "v1.30.0")).toMatchObject({ ok: true });
    expect(evaluateSkew("v1.30.0", "v1.31.0")).toMatchObject({ ok: true });
  });
  it("flags a client below the minimum", () => {
    const v = evaluateSkew("v1.29.0", "v1.29.0");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("below the minimum");
  });
  it("flags a >1 minor skew from the server", () => {
    const v = evaluateSkew("v1.33.0", "v1.31.0");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("minor");
  });

  it("flags a major-version mismatch with a major-specific reason", () => {
    const v = evaluateSkew("v2.0.0", "v1.31.0");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("major");
  });
  it("returns ok (no false alarm) when a version can't be parsed", () => {
    expect(evaluateSkew(null, "v1.31.0")).toMatchObject({ ok: true, reason: null });
    expect(evaluateSkew("v1.31.0", null)).toMatchObject({ ok: true, reason: null });
  });
  it("carries through the raw version strings for display", () => {
    expect(evaluateSkew("v1.31.0", "v1.31.13+k3s1")).toMatchObject({ client: "v1.31.0", server: "v1.31.13+k3s1" });
  });
});
