import { Elysia } from "elysia";
import { z } from "zod";
import { R2 } from "../lib/r2.ts";
import type { ApiDeps } from "./deps.ts";
import { DEFAULT_R2_SOURCE_ID, effectiveR2Config, saveR2Config, type R2SourceConfig } from "../services/r2-settings.ts";
import { bootstrapSetupServices, serviceInputFromConfig, setupServiceTemplates } from "../services/setup-services.ts";

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

const R2Body = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).default(DEFAULT_R2_SOURCE_ID),
  name: z.string().min(1).default("Default R2"),
  endpoint: z.string().url(),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().optional(),
  region: z.string().min(1).default("auto"),
});

const BootstrapBody = z.object({
  clusterId: z.string().min(1),
  namespace: z.string().min(1).default("default"),
  services: z.array(z.object({
    name: z.string().min(1).regex(ID_RE, "lowercase letters, digits, dot, dash"),
    r2Prefix: z.string().min(1),
    namespace: z.string().min(1).optional(),
    configEnv: z.string().default(""),
    secretEnv: z.string().default(""),
    manifestRoot: z.string().default("k8s"),
    imageTarPattern: z.string().default("{name}-{tag}-amd64.tar"),
    imageRefPrefix: z.string().default("docker.io/library"),
  })).min(1),
  r2SourceId: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).optional(),
  writeEnvTemplates: z.boolean().default(true),
  overwriteEnvTemplates: z.boolean().default(false),
});

const tags = ["setup"];

function r2Summary(deps: ApiDeps) {
  const cfg = deps.r2.getConfig();
  return {
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretConfigured: cfg.secretAccessKey.length > 0,
  };
}

function mergeR2Secret(deps: ApiDeps, parsed: z.infer<typeof R2Body>): R2SourceConfig {
  const current = deps.r2Sources.get(parsed.id);
  return {
    id: parsed.id,
    name: parsed.name,
    endpoint: parsed.endpoint,
    bucket: parsed.bucket,
    accessKeyId: parsed.accessKeyId,
    secretAccessKey: parsed.secretAccessKey?.trim() ? parsed.secretAccessKey : current.secretAccessKey,
    region: parsed.region,
  };
}

export const setupRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/setup/status",
      () => ({
        clusters: deps.clusters.list(),
        services: setupServiceTemplates(deps),
        r2: r2Summary(deps),
        r2Sources: deps.r2Sources.summaries(),
      }),
      { detail: { summary: "First-run setup status", tags } },
    )
    .get(
      "/setup/services",
      () => ({ items: setupServiceTemplates(deps) }),
      { detail: { summary: "Configured setup service templates", tags } },
    )
    .post(
      "/setup/bootstrap",
      async ({ body, status }) => {
        const parsed = BootstrapBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        if (!deps.clusters.get(parsed.data.clusterId)) return status(400, { error: `cluster '${parsed.data.clusterId}' not found` });
        return { items: await bootstrapSetupServices(deps, parsed.data) };
      },
      { detail: { summary: "Register configured services and seed env files", tags } },
    )
    .post(
      "/setup/bootstrap/config",
      async ({ body, status }) => {
        const parsed = z.object({
          clusterId: z.string().min(1),
          namespace: z.string().min(1).default("default"),
          r2SourceId: z.string().regex(ID_RE).optional(),
          writeEnvTemplates: z.boolean().default(true),
          overwriteEnvTemplates: z.boolean().default(false),
        }).safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        if (!deps.clusters.get(parsed.data.clusterId)) return status(400, { error: `cluster '${parsed.data.clusterId}' not found` });
        const services = deps.cfg.services.map((svc) => serviceInputFromConfig(svc, parsed.data.namespace));
        if (services.length === 0) return status(400, { error: "no services configured" });
        return { items: await bootstrapSetupServices(deps, { ...parsed.data, services }) };
      },
      { detail: { summary: "Register services from config and seed env files", tags } },
    )
    .get(
      "/settings/r2",
      () => r2Summary(deps),
      { detail: { summary: "Current R2 settings", tags } },
    )
    .get(
      "/settings/r2/sources",
      () => ({ items: deps.r2Sources.summaries() }),
      { detail: { summary: "List R2 sources", tags } },
    )
    .post(
      "/settings/r2/sources",
      ({ body, status }) => {
        const parsed = R2Body.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        try {
          const source = deps.r2Sources.upsert(mergeR2Secret(deps, parsed.data));
          if (source.id === DEFAULT_R2_SOURCE_ID) deps.cfg.r2 = source;
          return deps.r2Sources.summaries().find((item) => item.id === source.id);
        } catch (e) {
          return status(400, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Create or update an R2 source", tags } },
    )
    .delete(
      "/settings/r2/sources/:id",
      ({ params, status }) => {
        try {
          const removed = deps.r2Sources.delete(params.id, (id) => deps.registry.list().some((svc) => svc.sourceType === "r2-bundle" && (svc.r2SourceId ?? DEFAULT_R2_SOURCE_ID) === id));
          if (!removed) return status(404, { error: "R2 source not found" });
          return { ok: true };
        } catch (e) {
          return status(409, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Delete an unused R2 source", tags } },
    )
    .put(
      "/settings/r2",
      ({ body, status }) => {
        const parsed = R2Body.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const cfg = mergeR2Secret(deps, { ...parsed.data, id: DEFAULT_R2_SOURCE_ID, name: "Default R2" });
        saveR2Config(deps.state, cfg);
        deps.r2Sources.upsert(cfg);
        deps.cfg.r2 = cfg;
        return r2Summary(deps);
      },
      { detail: { summary: "Persist R2 settings", tags } },
    )
    .post(
      "/settings/r2/test",
      async ({ body, status }) => {
        let testConfig = effectiveR2Config(deps.state, deps.r2.getConfig());
        if (body && Object.keys(body as Record<string, unknown>).length > 0) {
          const parsed = R2Body.safeParse(body);
          if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
          testConfig = mergeR2Secret(deps, parsed.data);
        }
        try {
          const r2 = new R2(testConfig);
          const prefixes = (await r2.listPrefixes("")).slice(0, 20);
          return { ok: true, bucket: testConfig.bucket, prefixes };
        } catch (e) {
          return status(400, { ok: false, error: (e as Error).message });
        }
      },
      { detail: { summary: "Test R2 settings", tags } },
    )
    .post(
      "/settings/r2/sources/:id/test",
      async ({ params, status }) => {
        try {
          const source = deps.r2Sources.get(params.id);
          const r2 = new R2(source);
          const prefixes = (await r2.listPrefixes("")).slice(0, 20);
          return { ok: true, bucket: source.bucket, prefixes };
        } catch (e) {
          return status(400, { ok: false, error: (e as Error).message });
        }
      },
      { detail: { summary: "Test a saved R2 source", tags } },
    );
