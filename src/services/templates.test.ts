import { describe, it, expect } from "bun:test";
import {
  TEMPLATES,
  templateById,
  renderTemplateManifests,
  type TemplateDeployInput,
} from "./templates.ts";

describe("template catalog", () => {
  it("ships at least the staple public images operators reach for first", () => {
    const ids = TEMPLATES.map((t) => t.id).sort();
    for (const must of ["nginx", "redis", "postgres", "mysql", "mongodb", "rabbitmq"]) {
      expect(ids).toContain(must);
    }
  });

  it("each template declares a category, image, default port, and short description", () => {
    for (const tpl of TEMPLATES) {
      expect(tpl.label).toBeTruthy();
      expect(tpl.image).toMatch(/^[a-z0-9./_-]+$/);
      expect(tpl.defaultPort).toBeGreaterThan(0);
      expect(tpl.category).toBeTruthy();
      expect(tpl.description).toBeTruthy();
    }
  });

  it("templateById returns null on an unknown id", () => {
    expect(templateById("not-a-template")).toBeNull();
    expect(templateById("nginx")?.image).toBe("nginx");
  });

  it("postgres template declares the password env variable so the operator MUST set a secret", () => {
    const pg = templateById("postgres")!;
    const passwordEnv = pg.env.find((e) => e.key === "POSTGRES_PASSWORD");
    expect(passwordEnv).toBeDefined();
    expect(passwordEnv!.secret).toBe(true);
    expect(passwordEnv!.required).toBe(true);
  });
});

const baseInput: TemplateDeployInput = {
  templateId: "nginx",
  name: "web",
  namespace: "default",
  tag: "1.27",
  replicas: 3,
};

describe("renderTemplateManifests", () => {
  it("renders a Deployment matching the template image + tag + replicas", () => {
    const m = renderTemplateManifests(baseInput);
    expect(m.deployment.kind).toBe("Deployment");
    expect(m.deployment.metadata.name).toBe("web");
    expect(m.deployment.metadata.namespace).toBe("default");
    expect(m.deployment.spec.replicas).toBe(3);
    expect(m.deployment.spec.template.spec.containers[0]!.image).toBe("nginx:1.27");
    expect(m.deployment.spec.selector.matchLabels.app).toBe("web");
  });

  it("ALWAYS renders a v1/Service in front of the workload — the native LB across replicas", () => {
    const m = renderTemplateManifests(baseInput);
    expect(m.service.kind).toBe("Service");
    expect(m.service.metadata.name).toBe("web");
    expect(m.service.spec.selector.app).toBe("web");
    // Single port mirrors the template's defaultPort (nginx → 80)
    expect(m.service.spec.ports).toEqual([
      { name: "http", port: 80, targetPort: 80, protocol: "TCP" },
    ]);
  });

  it("renders Service type=ClusterIP by default and NodePort when requested", () => {
    expect(renderTemplateManifests(baseInput).service.spec.type).toBe("ClusterIP");
    const m = renderTemplateManifests({ ...baseInput, serviceType: "NodePort" });
    expect(m.service.spec.type).toBe("NodePort");
  });

  it("injects required env vars from the input (passwords as Secret keys, not literal values)", () => {
    const m = renderTemplateManifests({
      templateId: "postgres",
      name: "pg",
      namespace: "data",
      tag: "16",
      replicas: 1,
      env: { POSTGRES_PASSWORD: "supersecret", POSTGRES_USER: "celeste" },
    });
    const container = m.deployment.spec.template.spec.containers[0]!;
    const envByName = new Map(container.env!.map((e) => [e.name, e]));
    // Required + secret → projected through a Secret keyref, not as a plain value
    const pw = envByName.get("POSTGRES_PASSWORD")!;
    expect(pw.value).toBeUndefined();
    expect(pw.valueFrom?.secretKeyRef?.name).toBe("pg-secret");
    expect(pw.valueFrom?.secretKeyRef?.key).toBe("POSTGRES_PASSWORD");
    // Non-secret → plain value
    expect(envByName.get("POSTGRES_USER")!.value).toBe("celeste");
    // And the Secret manifest is rendered too, with base64-encoded data
    expect(m.secret).toBeDefined();
    expect(m.secret!.metadata.name).toBe("pg-secret");
    expect(Buffer.from(m.secret!.data!.POSTGRES_PASSWORD!, "base64").toString("utf-8")).toBe("supersecret");
  });

  it("rejects a deploy when a required secret env was not supplied", () => {
    expect(() =>
      renderTemplateManifests({
        templateId: "postgres",
        name: "pg",
        namespace: "data",
        tag: "16",
        replicas: 1,
      }),
    ).toThrow(/POSTGRES_PASSWORD/);
  });

  it("emits an HPA when autoscaling is requested with min/max + CPU target", () => {
    const m = renderTemplateManifests({
      ...baseInput,
      autoscale: { minReplicas: 2, maxReplicas: 10, targetCPUUtilizationPercentage: 70 },
    });
    expect(m.hpa).toBeDefined();
    expect(m.hpa!.spec.minReplicas).toBe(2);
    expect(m.hpa!.spec.maxReplicas).toBe(10);
    expect(m.hpa!.spec.scaleTargetRef).toEqual({ apiVersion: "apps/v1", kind: "Deployment", name: "web" });
    const cpu = m.hpa!.spec.metrics![0]!;
    expect(cpu.resource?.name).toBe("cpu");
    expect(cpu.resource?.target?.averageUtilization).toBe(70);
  });

  it("does NOT emit an HPA when autoscaling is omitted", () => {
    expect(renderTemplateManifests(baseInput).hpa).toBeUndefined();
  });

  it("rejects an HPA with min > max (the operator's pick must already be valid)", () => {
    expect(() =>
      renderTemplateManifests({
        ...baseInput,
        autoscale: { minReplicas: 5, maxReplicas: 2, targetCPUUtilizationPercentage: 70 },
      }),
    ).toThrow(/min.*max/);
  });

  it("rejects an invalid RFC-1123 name", () => {
    expect(() => renderTemplateManifests({ ...baseInput, name: "Bad Name!" })).toThrow(/name/);
  });

  it("rejects replicas < 1 or > 1000", () => {
    expect(() => renderTemplateManifests({ ...baseInput, replicas: 0 })).toThrow(/replicas/);
    expect(() => renderTemplateManifests({ ...baseInput, replicas: 1001 })).toThrow(/replicas/);
  });
});
