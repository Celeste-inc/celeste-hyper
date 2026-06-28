import { describe, it, expect } from "bun:test";
import { categorize } from "./categorize.ts";

const app = { namespace: "shop", kind: "Deployment", name: "web", labels: {} };

describe("categorize", () => {
  it("classifies kube-system workloads as infrastructure by default", () => {
    expect(categorize({ ...app, namespace: "kube-system" }, {}, undefined)).toBe("infrastructure");
  });

  it("classifies ordinary app namespaces as application", () => {
    expect(categorize(app, {}, undefined)).toBe("application");
  });

  it("matches the default regex (cattle-system) as infrastructure", () => {
    expect(categorize({ ...app, namespace: "cattle-system" }, {}, undefined)).toBe("infrastructure");
  });

  it("honors a custom infraNamespaceRegex", () => {
    expect(categorize({ ...app, namespace: "infra-x" }, { infraNamespaceRegex: "^infra-" }, undefined)).toBe("infrastructure");
  });

  it("tags Helm-managed kube-system parts as infrastructure", () => {
    const w = { namespace: "shop", kind: "Deployment", name: "x", labels: { "app.kubernetes.io/managed-by": "Helm", "app.kubernetes.io/part-of": "kube-system" } };
    expect(categorize(w, {}, undefined)).toBe("infrastructure");
  });

  it("hides celeste-hyper's own workload via the component label", () => {
    expect(categorize({ ...app, labels: { "app.kubernetes.io/component": "celeste-hyper" } }, {}, undefined)).toBe("infrastructure");
  });

  it("an operator override beats the default (application wins over infra namespace)", () => {
    expect(categorize({ ...app, namespace: "kube-system" }, {}, "application")).toBe("application");
    expect(categorize(app, {}, "infrastructure")).toBe("infrastructure");
  });

  it("uses a precompiled infraRegex when provided", () => {
    expect(categorize({ ...app, namespace: "infra-x" }, { infraRegex: /^infra-/ }, undefined)).toBe("infrastructure");
    expect(categorize({ ...app, namespace: "kube-system" }, { infraRegex: null }, undefined)).toBe("infrastructure"); // ns list still applies
    expect(categorize(app, { infraRegex: null }, undefined)).toBe("application");
  });
});
