import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import {
  REGISTRY_PRESETS,
  composeImageRef,
  buildImagePullSecretManifest,
  type RegistryPresetId,
} from "../services/registry-presets.ts";

const PresetIds = ["ghcr", "acr", "docker-hub", "quay", "harbor", "ecr"] as const;

const ComposeBody = z
  .object({
    presetId: z.enum(PresetIds),
    registry: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    namespace: z.string().min(1),
    image: z.string().min(1),
  })
  .strict();

const PullSecretBody = z
  .object({
    clusterId: z.string().min(1),
    namespace: z.string().min(1),
    secretName: z.string().min(1),
    preset: z
      .object({
        presetId: z.enum(PresetIds),
        registry: z.string().min(1).optional(),
        region: z.string().min(1).optional(),
        username: z.string().min(1),
        password: z.string().min(1),
        email: z.string().email().optional(),
      })
      .strict(),
  })
  .strict();

const tags = ["registries"];

function toYaml(secret: ReturnType<typeof buildImagePullSecretManifest>): string {
  return [
    `apiVersion: ${secret.apiVersion}`,
    `kind: ${secret.kind}`,
    `type: ${secret.type}`,
    "metadata:",
    `  name: ${secret.metadata.name}`,
    `  namespace: ${secret.metadata.namespace}`,
    "data:",
    `  .dockerconfigjson: ${secret.data[".dockerconfigjson"]}`,
    "",
  ].join("\n");
}

export const registryRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/registries/presets",
      () => ({ items: REGISTRY_PRESETS }),
      { detail: { summary: "List well-known container registry presets", tags } },
    )
    .post(
      "/registries/compose",
      ({ body, status }) => {
        const parsed = ComposeBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        try {
          const imageRef = composeImageRef({
            presetId: parsed.data.presetId as RegistryPresetId,
            registry: parsed.data.registry,
            region: parsed.data.region,
            namespace: parsed.data.namespace,
            image: parsed.data.image,
          });
          return { imageRef };
        } catch (e) {
          return status(422, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Compose an image reference for the chosen preset", tags } },
    )
    .post(
      "/registries/pull-secret",
      async ({ body, status }) => {
        const parsed = PullSecretBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        if (!deps.clusters.get(parsed.data.clusterId)) return status(404, { error: "cluster not found" });
        const k8s = deps.pool.get(parsed.data.clusterId);
        if (!k8s) return status(404, { error: "cluster not found" });
        let manifest: ReturnType<typeof buildImagePullSecretManifest>;
        try {
          manifest = buildImagePullSecretManifest({
            name: parsed.data.secretName,
            namespace: parsed.data.namespace,
            preset: {
              presetId: parsed.data.preset.presetId as RegistryPresetId,
              registry: parsed.data.preset.registry,
              region: parsed.data.preset.region,
              username: parsed.data.preset.username,
              password: parsed.data.preset.password,
              email: parsed.data.preset.email,
            },
          });
        } catch (e) {
          return status(422, { error: (e as Error).message });
        }
        const r = await k8s.applyManifest(toYaml(manifest), parsed.data.namespace);
        if (r.code !== 0) return status(502, { error: (r.stderr || r.stdout).trim().slice(0, 200) });
        return { secretName: parsed.data.secretName, namespace: parsed.data.namespace };
      },
      { detail: { summary: "Provision an imagePullSecret on a cluster from a registry preset", tags } },
    );
