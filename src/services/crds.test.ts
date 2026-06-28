import { describe, it, expect } from "bun:test";
import { parseCrdList, parseCrList, crdResource, isValidResource, isValidName } from "./crds.ts";

const crdJson = JSON.stringify({
  items: [
    {
      metadata: { name: "certificates.cert-manager.io" },
      spec: {
        group: "cert-manager.io",
        names: { kind: "Certificate", plural: "certificates" },
        scope: "Namespaced",
        versions: [{ name: "v1alpha2", served: true, storage: false }, { name: "v1", served: true, storage: true }],
      },
    },
    {
      metadata: { name: "clusterissuers.cert-manager.io" },
      spec: { group: "cert-manager.io", names: { kind: "ClusterIssuer", plural: "clusterissuers" }, scope: "Cluster", versions: [{ name: "v1", served: true, storage: true }] },
    },
    { metadata: { name: "broken" }, spec: { group: "x" } }, // missing names → skipped
  ],
});

describe("parseCrdList", () => {
  it("extracts group/version/kind/plural/scope, prefers the storage version, and sorts", () => {
    const out = parseCrdList(crdJson);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: "certificates.cert-manager.io", group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", scope: "Namespaced", namespaced: true });
    expect(out[1]).toMatchObject({ kind: "ClusterIssuer", scope: "Cluster", namespaced: false });
  });
  it("returns [] on malformed input", () => {
    expect(parseCrdList("nope")).toEqual([]);
    expect(parseCrdList("{}")).toEqual([]);
  });
});

describe("crdResource", () => {
  it("builds <plural>.<group>", () => {
    expect(crdResource({ plural: "certificates", group: "cert-manager.io" })).toBe("certificates.cert-manager.io");
  });
});

describe("parseCrList", () => {
  it("extracts object name/namespace/createdAt", () => {
    const json = JSON.stringify({ items: [{ metadata: { name: "web-tls", namespace: "prod", creationTimestamp: "2026-06-28T00:00:00Z" } }, { metadata: { name: "no-ns" } }] });
    expect(parseCrList(json)).toEqual([
      { name: "web-tls", namespace: "prod", createdAt: "2026-06-28T00:00:00Z" },
      { name: "no-ns", namespace: null, createdAt: null },
    ]);
  });
  it("returns [] on malformed input", () => expect(parseCrList("x")).toEqual([]));
});

describe("validation", () => {
  it("accepts a real <plural>.<group> and rejects junk", () => {
    expect(isValidResource("certificates.cert-manager.io")).toBe(true);
    expect(isValidResource("nogroup")).toBe(false); // no dot
    expect(isValidResource("-evil.io")).toBe(false); // leading dash (flag-injection)
    expect(isValidResource("a b.io")).toBe(false); // whitespace
  });
  it("validates object names", () => {
    expect(isValidName("web-tls")).toBe(true);
    expect(isValidName("--all")).toBe(false);
    expect(isValidName("a/b")).toBe(false);
  });
});
