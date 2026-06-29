import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import { buildImagePullSecretManifest, type RegistryPresetId } from "../services/registry-presets.ts";
import { stringify as yamlStringify } from "./yaml.ts";
import { testRegistryConnection, type RegistryTestFetcher } from "../services/registry-test.ts";

const PresetIds = ["ghcr", "acr", "docker-hub", "quay", "harbor", "ecr"] as const;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const RFC1123 = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

const UpsertBody = z
  .object({
    id: z.string().regex(SOURCE_ID_RE),
    name: z.string().min(1).max(120),
    presetId: z.enum(PresetIds),
    registry: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    username: z.string().min(1),
    /** Omit on update to preserve the previously stored password. */
    password: z.string().min(1).optional(),
    email: z.string().email().optional(),
  })
  .strict();

const ApplyBody = z
  .object({
    clusterId: z.string().min(1),
    namespace: z.string().regex(RFC1123),
    secretName: z.string().regex(RFC1123),
  })
  .strict();

const TestBody = z
  .object({
    presetId: z.enum(PresetIds),
    registry: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    username: z.string().min(1),
    password: z.string().min(1).optional(),
  })
  .strict();

const tags = ["settings"];

// Cast deps.fetch to a RegistryTestFetcher — both expect the same { ok, status, headers, json,
// text } envelope. When unset (no outbound HTTP configured), fall back to the global fetch.
function getFetcher(deps: ApiDeps): RegistryTestFetcher {
  const f = deps.fetch as unknown as RegistryTestFetcher | undefined;
  if (f) return f;
  return async (url, init) => {
    const r = await fetch(url, init);
    return {
      ok: r.ok,
      status: r.status,
      headers: { get: (n: string) => r.headers.get(n) },
      json: () => r.json() as Promise<unknown>,
      text: () => r.text(),
    };
  };
}

export const registrySourceRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/settings/registries",
      () => ({ items: deps.registrySources.list() }),
      { detail: { summary: "List stored registry credentials (admin)", tags } },
    )
    .post(
      "/settings/registries",
      ({ body, status }) => {
        const parsed = UpsertBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        try {
          const summary = deps.registrySources.upsert({
            id: parsed.data.id,
            name: parsed.data.name,
            presetId: parsed.data.presetId as RegistryPresetId,
            registry: parsed.data.registry,
            region: parsed.data.region,
            username: parsed.data.username,
            password: parsed.data.password,
            email: parsed.data.email,
          });
          return { source: summary };
        } catch (e) {
          return status(422, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Create or update a registry source", tags } },
    )
    .delete(
      "/settings/registries/:id",
      ({ params, status }) => {
        const inUse = (id: string) => deps.registry.list().some((svc) => (svc as { registrySourceId?: string }).registrySourceId === id);
        try {
          if (inUse(params.id)) return status(409, { error: `registry source '${params.id}' is in use by a service` });
          const ok = deps.registrySources.delete(params.id, () => false);
          if (!ok) return status(404, { error: "not found" });
          return { ok: true };
        } catch (e) {
          return status(409, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Delete a registry source (refused while a service links it)", tags } },
    )
    .post(
      "/settings/registries/:id/apply",
      async ({ params, body, status }) => {
        const source = deps.registrySources.get(params.id);
        if (!source) return status(404, { error: "registry source not found" });
        const parsed = ApplyBody.safeParse(body ?? {});
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
        const r = await k8s.applyManifest(yamlStringify(manifest), parsed.data.namespace);
        if (r.code !== 0) return status(502, { error: (r.stderr || r.stdout).trim().slice(0, 200) });
        return { ok: true, secretName: parsed.data.secretName, namespace: parsed.data.namespace, clusterId: parsed.data.clusterId };
      },
      { detail: { summary: "Provision the imagePullSecret on a cluster + namespace from this source", tags } },
    )
    .post(
      "/settings/registries/test",
      async ({ body, status }) => {
        const parsed = TestBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        if (!parsed.data.password) return status(422, { error: "password is required to test the connection" });
        const result = await testRegistryConnection(
          {
            presetId: parsed.data.presetId as RegistryPresetId,
            registry: parsed.data.registry,
            region: parsed.data.region,
            username: parsed.data.username,
            password: parsed.data.password,
          },
          getFetcher(deps),
        );
        return result;
      },
      { detail: { summary: "Validate registry credentials against the live registry (OCI v2 token flow)", tags } },
    )
    .post(
      "/settings/registries/:id/test",
      async ({ params, body, status }) => {
        const source = deps.registrySources.get(params.id);
        if (!source) return status(404, { error: "registry source not found" });
        // Allow the operator to test with a one-shot override password without persisting it (useful
        // when rotating creds: "did this new PAT work?" before saving).
        const override = (body && typeof body === "object" && "password" in body && typeof (body as { password?: unknown }).password === "string")
          ? (body as { password: string }).password
          : null;
        const result = await testRegistryConnection(
          {
            presetId: source.presetId,
            registry: source.registry,
            region: source.region,
            username: source.username,
            password: override ?? source.password,
          },
          getFetcher(deps),
        );
        return result;
      },
      { detail: { summary: "Validate a saved registry source's credentials against the live registry", tags } },
    );
