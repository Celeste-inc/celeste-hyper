import { describe, it, expect } from "bun:test";
import { buildCanaryManifest, buildColorManifest } from "./deploy-manifest.ts";

const base = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "shop", uid: "abc", resourceVersion: "99", labels: { app: "web" } },
  spec: {
    replicas: 4,
    selector: { matchLabels: { app: "web" } },
    template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "img:old" }] } },
  },
  status: { readyReplicas: 4 },
};

describe("buildCanaryManifest", () => {
  it("renames, sets image + replicas, strips server fields, marks the canary", () => {
    const m = buildCanaryManifest(base, "web-canary", "web", "img:new", 1);
    expect(m.metadata!.name).toBe("web-canary");
    expect(m.spec!.replicas).toBe(1);
    expect(m.spec!.template!.spec!.containers![0]!.image).toBe("img:new");
    expect(m.spec!.selector!.matchLabels!["celeste-hyper/canary"]).toBe("web-canary");
    expect(m.spec!.template!.metadata!.labels!["celeste-hyper/canary"]).toBe("web-canary");
    expect(m.spec!.selector!.matchLabels!.app).toBe("web"); // keeps app label → Service still routes to it
    expect(m.metadata!.uid).toBeUndefined();
    expect(m.metadata!.resourceVersion).toBeUndefined();
    expect(m.status).toBeUndefined();
  });

  it("drops only server-managed annotations, keeps operator annotations", () => {
    const withAnn = {
      ...base,
      metadata: {
        ...base.metadata,
        annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{...}", "team": "payments" },
      },
    };
    const m = buildCanaryManifest(withAnn, "web-canary", "web", "img:new", 1);
    const ann = (m.metadata as { annotations?: Record<string, string> }).annotations!;
    expect(ann["kubectl.kubernetes.io/last-applied-configuration"]).toBeUndefined();
    expect(ann.team).toBe("payments");
  });

  it("does not mutate the base", () => {
    buildCanaryManifest(base, "web-canary", "web", "img:new", 1);
    expect(base.spec.template.spec.containers[0]!.image).toBe("img:old");
    expect(base.metadata.uid).toBe("abc");
  });
});

describe("buildColorManifest", () => {
  it("uses a fresh label set (no app label) so it isn't routed to until the flip", () => {
    const { manifest, labels } = buildColorManifest(base, "web-green", "web", "web", "img:new", "green");
    expect(manifest.metadata!.name).toBe("web-green");
    expect(labels).toEqual({ "celeste-hyper/managed": "web", "celeste-hyper/color": "green" });
    expect(manifest.spec!.selector!.matchLabels).toEqual(labels);
    expect(manifest.spec!.template!.metadata!.labels).toEqual(labels);
    expect(manifest.spec!.template!.metadata!.labels!.app).toBeUndefined(); // no app label → no pre-flip split
    expect(manifest.spec!.template!.spec!.containers![0]!.image).toBe("img:new");
    expect(manifest.status).toBeUndefined();
  });
});
