import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import {
  TEMPLATES,
  renderCustomManifests,
  renderTemplateManifests,
  templateById,
  type RenderedManifests,
} from "../services/templates.ts";
import { searchDockerHub } from "../services/dockerhub.ts";
import { stringify as yamlStringify } from "./yaml.ts";
import { buildImagePullSecretManifest } from "../services/registry-presets.ts";
import * as envFiles from "../lib/env-files.ts";

const RFC1123 = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

const SearchQuery = z.object({
  q: z.string().min(1, "query is required").max(120),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const DeployBody = z
  .object({
    templateId: z.string().min(1),
    name: z.string().regex(RFC1123, "invalid name (RFC 1123)"),
    namespace: z.string().regex(RFC1123, "invalid namespace"),
    clusterId: z.string().min(1),
    replicas: z.number().int().min(1).max(1000).default(1),
    tag: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    serviceType: z.enum(["ClusterIP", "NodePort", "LoadBalancer"]).optional(),
    autoscale: z
      .object({
        minReplicas: z.number().int().min(1),
        maxReplicas: z.number().int().min(1),
        targetCPUUtilizationPercentage: z.number().int().min(1).max(100),
      })
      .optional(),
    imagePullSecret: z.string().min(1).optional(),
    /** Link a stored registry source — Hyper provisions its imagePullSecret on the target cluster + namespace before applying the workload. */
    registrySourceId: z.string().min(1).optional(),
    /** When templateId === "custom": the arbitrary image ref to deploy (e.g. from a Docker Hub search). */
    customImage: z.string().min(1).max(512).optional(),
    /** When templateId === "custom": the containerPort + Service port. */
    customPort: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

const tags = ["templates"];

interface AppliedKind {
  kind: string;
  name: string;
  namespace: string;
}

function manifestsAsList(m: RenderedManifests): Array<{ kind: string; obj: unknown; name: string }> {
  const out: Array<{ kind: string; obj: unknown; name: string }> = [];
  if (m.secret) out.push({ kind: "Secret", obj: m.secret, name: m.secret.metadata.name });
  out.push({ kind: "Service", obj: m.service, name: m.service.metadata.name });
  out.push({ kind: "Deployment", obj: m.deployment, name: m.deployment.metadata.name });
  if (m.hpa) out.push({ kind: "HorizontalPodAutoscaler", obj: m.hpa, name: m.hpa.metadata.name });
  return out;
}

export const templateRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/templates",
      () => ({ items: TEMPLATES }),
      { detail: { summary: "Curated catalog of public images (nginx, redis, postgres, …)", tags } },
    )
    .get(
      "/templates/search",
      async ({ query, status }) => {
        const parsed = SearchQuery.safeParse(query);
        if (!parsed.success) return status(422, { error: "invalid query", issues: parsed.error.issues });
        try {
          const items = await searchDockerHub(parsed.data.q, {
            fetcher: deps.fetch,
            pageSize: parsed.data.pageSize,
          });
          return { items };
        } catch (e) {
          return status(502, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Search public images on Docker Hub", tags } },
    )
    .post(
      "/templates/deploy",
      async ({ body, status }) => {
        const parsed = DeployBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const isCustom = parsed.data.templateId === "custom";
        const tpl = isCustom ? null : templateById(parsed.data.templateId);
        if (!isCustom && !tpl) return status(422, { error: `unknown template '${parsed.data.templateId}'` });
        if (isCustom && !parsed.data.customImage) return status(422, { error: "customImage is required when templateId is 'custom'" });
        if (!deps.clusters.get(parsed.data.clusterId)) return status(400, { error: `cluster '${parsed.data.clusterId}' not found` });
        const k8s = deps.pool.get(parsed.data.clusterId);
        if (!k8s) return status(400, { error: `cluster '${parsed.data.clusterId}' not configured` });

        const customPort = parsed.data.customPort ?? 80;
        const imageRef = isCustom ? parsed.data.customImage! : tpl!.image;
        const tagToDeploy = parsed.data.tag ?? (isCustom ? "latest" : tpl!.defaultTag);

        // Ensure the target namespace exists — common usability win (operators forget to kubectl
        // create ns first). create-or-update via apply so re-runs are idempotent.
        const nsManifest = {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: parsed.data.namespace, labels: { "celeste.dev/managed": "true" } },
        };
        const nsRes = await k8s.applyManifest(yamlStringify(nsManifest));
        if (nsRes.code !== 0) {
          return status(502, { error: `failed to ensure namespace '${parsed.data.namespace}': ${(nsRes.stderr || nsRes.stdout).trim().slice(0, 200)}` });
        }

        // If a registry source is linked, materialise its imagePullSecret on the target ns BEFORE applying
        // the workload — so the kubelet has credentials when it tries to pull the private image.
        let resolvedImagePullSecret = parsed.data.imagePullSecret;
        if (parsed.data.registrySourceId) {
          const source = deps.registrySources.get(parsed.data.registrySourceId);
          if (!source) return status(422, { error: `registry source '${parsed.data.registrySourceId}' not found` });
          const secretName = `celeste-registry-${source.id}`;
          let pullSecret: ReturnType<typeof buildImagePullSecretManifest>;
          try {
            pullSecret = buildImagePullSecretManifest({
              name: secretName,
              namespace: parsed.data.namespace,
              preset: {
                presetId: source.presetId,
                registry: source.registry,
                region: source.region,
                username: source.username,
                password: source.password,
                email: source.email,
              },
            });
          } catch (e) {
            return status(422, { error: (e as Error).message });
          }
          const applyR = await k8s.applyManifest(yamlStringify(pullSecret), parsed.data.namespace);
          if (applyR.code !== 0) {
            return status(502, { error: (applyR.stderr || applyR.stdout).trim().slice(0, 200) });
          }
          resolvedImagePullSecret = secretName;
        }

        let manifests: RenderedManifests;
        try {
          manifests = isCustom
            ? renderCustomManifests({
                image: parsed.data.customImage!,
                port: customPort,
                name: parsed.data.name,
                namespace: parsed.data.namespace,
                replicas: parsed.data.replicas,
                tag: parsed.data.tag,
                env: parsed.data.env,
                serviceType: parsed.data.serviceType,
                autoscale: parsed.data.autoscale,
                imagePullSecret: resolvedImagePullSecret,
              })
            : renderTemplateManifests({
                templateId: parsed.data.templateId,
                name: parsed.data.name,
                namespace: parsed.data.namespace,
                replicas: parsed.data.replicas,
                tag: parsed.data.tag,
                env: parsed.data.env,
                serviceType: parsed.data.serviceType,
                autoscale: parsed.data.autoscale,
                imagePullSecret: resolvedImagePullSecret,
              });
        } catch (e) {
          return status(422, { error: (e as Error).message });
        }

        // Pre-register so the deploy is visible in /api/services right away.
        // autoRedeployOnEnv: ON by default — operators editing a template service's env (e.g. rotating
        // RabbitMQ/Postgres passwords) get a redeploy at the current tag automatically.
        let created: ReturnType<typeof deps.registry.create>;
        try {
          created = deps.registry.create({
            sourceType: "registry-pull",
            name: parsed.data.name,
            namespace: parsed.data.namespace,
            clusterId: parsed.data.clusterId,
            imageRef,
            workloadKind: "Deployment",
            workloadName: parsed.data.name,
            containerName: parsed.data.name,
            enabled: true,
            imagePullSecret: resolvedImagePullSecret,
            registrySourceId: parsed.data.registrySourceId,
            autoRedeployOnEnv: true,
          } as never);
        } catch (e) {
          return status(409, { error: (e as Error).message });
        }

        // Persist env values to <envFilesDir>/<service>/{config,secret}.env so the Edit env modal
        // can mutate them post-deploy. The Secret/ConfigMap manifests we just applied carry the
        // initial values; the env-files become the source-of-truth for subsequent edits.
        try {
          const providedEnv = parsed.data.env ?? {};
          const configRows: envFiles.EnvRow[] = [];
          const secretRows: envFiles.EnvRow[] = [];
          if (tpl) {
            for (const e of tpl.env) {
              const value = providedEnv[e.key] ?? e.default;
              if (value === undefined) continue;
              const row: envFiles.EnvRow = { key: e.key, value, description: e.description };
              if (e.secret) secretRows.push(row);
              else configRows.push(row);
            }
          } else {
            // Custom image: we don't know which keys are secret-shaped, so persist everything as config.env.
            for (const [k, v] of Object.entries(providedEnv)) configRows.push({ key: k, value: v });
          }
          if (configRows.length > 0) {
            await envFiles.write(deps.cfg.envFilesDir, parsed.data.name, "config", envFiles.serializeRows(configRows).content);
          }
          if (secretRows.length > 0) {
            await envFiles.write(deps.cfg.envFilesDir, parsed.data.name, "secret", envFiles.serializeRows(secretRows).content);
          }
        } catch {
          // env-files are a UX convenience; if the filesystem write fails the deploy still succeeded.
        }

        // Apply manifests in order (Secret → Service → Deployment → HPA) so when the Deployment lands
        // the Secret already exists and the Service is ready to front the new pods.
        const applied: AppliedKind[] = [];
        for (const m of manifestsAsList(manifests)) {
          const yaml = yamlStringify(m.obj);
          const r = await k8s.applyManifest(yaml, parsed.data.namespace);
          if (r.code !== 0) {
            // Best-effort rollback: undo the registry row so the operator can retry without a duplicate.
            deps.registry.delete(parsed.data.name);
            return status(502, { error: (r.stderr || r.stdout).trim().slice(0, 200), applied });
          }
          applied.push({ kind: m.kind, name: m.name, namespace: parsed.data.namespace });
        }

        // Record an initial successful "deployment" entry so the UI's deploy stream + history light up.
        const deploymentId = deps.state.recordDeploymentStart(parsed.data.name, tagToDeploy);
        deps.state.updateDeployment(deploymentId, "done", "template applied");
        deps.state.setCurrent(parsed.data.name, tagToDeploy);

        return status(201, {
          service: created,
          deploymentId,
          applied,
          loadBalancer: {
            kind: parsed.data.serviceType ?? "ClusterIP",
            replicas: parsed.data.replicas,
            message: `Native LB via v1/Service '${parsed.data.name}' (selector app=${parsed.data.name}) — kube-proxy distributes traffic across all ${parsed.data.replicas} replicas.`,
          },
        });
      },
      { detail: { summary: "One-click deploy of a public-image template (Deployment + Service + optional HPA)", tags } },
    );
