import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import { CreateServiceSchema, UpdateServiceSchema, type ServiceModel } from "../services/model.ts";
import { listVersions } from "../services/discovery.ts";
import { parseLsRemote, validateGitUrl, validateGitPath, validateDeployKeyPath } from "../lib/git.ts";
import type { Config } from "../config.ts";

/**
 * Validate the git-sync fields present in a create/update body (SSRF allowlist + path traversal).
 * Returns an error string (→ 422) or null. Only checks fields that are present, so a partial PATCH
 * that doesn't touch git fields is unaffected.
 */
function gitSyncError(data: { sourceType?: unknown; gitUrl?: unknown; gitPath?: unknown; deployKeyPath?: unknown }, cfg: Config): string | null {
  if (data.sourceType !== "git-sync") return null;
  if (typeof data.gitUrl === "string") {
    const v = validateGitUrl(data.gitUrl, cfg.git.hostAllowlist);
    if (!v.ok) return v.error;
  }
  if (typeof data.gitPath === "string") {
    const v = validateGitPath(data.gitPath);
    if (!v.ok) return v.error;
  }
  if (typeof data.deployKeyPath === "string" && data.deployKeyPath) {
    const v = validateDeployKeyPath(data.deployKeyPath, cfg.git.keysDir);
    if (!v.ok) return v.error;
  }
  return null;
}
import { listRegistryTags, sortTagsDesc } from "../lib/registry.ts";
import * as envFiles from "../lib/env-files.ts";

const tags = ["services"];

const AdoptBody = z.object({
  name: z.string().min(1).optional(),
  namespace: z.string().min(1),
  clusterId: z.string().min(1),
  workloadKind: z.enum(["Deployment", "StatefulSet", "DaemonSet"]).default("Deployment"),
  workloadName: z.string().min(1),
  containerName: z.string().min(1),
  imageRef: z.string().min(1),
  imagePullSecret: z.string().optional(),
});

export const serviceRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/services",
      async () => {
        const snap = deps.poller.getSnapshot();
        const items = await Promise.all(
          deps.registry.list().map(async (s) => {
            const current = deps.state.getCurrent(s.name);
            const cfgSummary = await envFiles.summary(deps.cfg.envFilesDir, s.name, "config");
            const secSummary = await envFiles.summary(deps.cfg.envFilesDir, s.name, "secret");
            const cluster = snap.cluster.find(
              (w) => w.name === s.name && w.namespace === s.namespace && w.clusterId === s.clusterId,
            );
            return {
              ...s,
              currentTag: current?.tag ?? null,
              deployedAt: current?.deployed_at ?? null,
              env: {
                config: { path: cfgSummary.path, exists: cfgSummary.exists, keys: cfgSummary.keys },
                secret: { path: secSummary.path, exists: secSummary.exists, keys: secSummary.keys },
              },
              cluster: cluster
                ? {
                    kind: cluster.kind,
                    replicas: cluster.replicas,
                    readyReplicas: cluster.readyReplicas,
                    containers: cluster.containers,
                  }
                : null,
              newVersion: snap.newVersions[s.name] ?? null,
            };
          }),
        );
        // Workloads declared as `relatedWorkloads` on a managed service are owned by that service
        // (they show up grouped under it on the service page), so they must not also surface in
        // the "discovered" list — that would let the operator adopt them as a separate service
        // by mistake. Key on (clusterId, namespace, kind, name) which is what `snap.cluster` uses.
        const adoptedRelated = new Set<string>();
        for (const s of deps.registry.list()) {
          for (const r of s.relatedWorkloads ?? []) {
            adoptedRelated.add(`${s.clusterId}|${s.namespace}|${r.kind}|${r.name}`);
          }
        }
        const isAdopted = (w: typeof snap.cluster[number]) =>
          adoptedRelated.has(`${w.clusterId}|${w.namespace}|${w.kind}|${w.name}`);
        const discoverable = snap.cluster.filter((w) => !w.managed && !isAdopted(w));
        const unmanaged = discoverable.filter((w) => w.category !== "infrastructure");
        const infrastructure = discoverable.filter((w) => w.category === "infrastructure");
        return { items, unmanaged, infrastructure, lastTickAt: snap.lastTickAt };
      },
      { detail: { summary: "List managed services and unmanaged workloads", tags } },
    )
    .get(
      "/services/:name",
      ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const current = deps.state.getCurrent(svc.name);
        return { service: svc, currentTag: current?.tag ?? null, deployedAt: current?.deployed_at ?? null };
      },
      { detail: { summary: "Get a service", tags } },
    )
    .post(
      "/services",
      ({ body, status }) => {
        const parsed = CreateServiceSchema.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        if (!deps.clusters.get(parsed.data.clusterId))
          return status(400, { error: `cluster '${parsed.data.clusterId}' not found` });
        const gitErr = gitSyncError(parsed.data, deps.cfg);
        if (gitErr) return status(422, { error: gitErr });
        try {
          const created = deps.registry.create(parsed.data);
          return status(201, { service: created });
        } catch (e) {
          return status(409, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Create a service", tags } },
    )
    .patch(
      "/services/:name",
      ({ params, body, status }) => {
        const parsed = UpdateServiceSchema.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        if (parsed.data.clusterId && !deps.clusters.get(parsed.data.clusterId))
          return status(400, { error: `cluster '${parsed.data.clusterId}' not found` });
        // Validate git fields from the RAW body (only what was sent) against the allowlist + traversal.
        const gitErr = gitSyncError(body as Record<string, unknown>, deps.cfg);
        if (gitErr) return status(422, { error: gitErr });
        const current = deps.registry.get(params.name);
        // The effective workload kind is the stored one (the partial schema can't reliably express a
        // kind *change*; canary/blue-green require an existing Deployment).
        const effMode = (parsed.data as { deployMode?: string }).deployMode ?? current?.deployMode ?? "rolling";
        if (current && (effMode === "canary" || effMode === "blue-green")) {
          // Effective kind = the kind explicitly sent in THIS patch (read from the RAW body, since
          // parsed.data carries the schema default), else the stored kind. Closes the
          // `{ workloadKind: StatefulSet, deployMode: canary }` same-body bypass.
          const sentKind = (body as { workloadKind?: string } | null)?.workloadKind;
          const kind = current.sourceType === "registry-pull" ? sentKind ?? current.workloadKind : null;
          if (kind !== "Deployment") {
            return status(422, { error: `${effMode} requires a registry-pull Deployment workload`, reason: "mode-workload-mismatch" });
          }
        }
        try {
          // Apply only the fields the caller actually sent: the partial schema still fills absent
          // fields with their `.default()` (e.g. workloadKind→Deployment), which would clobber
          // stored values on a partial PATCH. Restrict to keys present in the raw body.
          const sent = new Set(Object.keys((body ?? {}) as Record<string, unknown>));
          const patchData = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => sent.has(k))) as Partial<ServiceModel>;
          const updated = deps.registry.update(params.name, patchData);
          return { service: updated };
        } catch (e) {
          return status(400, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Update a service", tags } },
    )
    .delete(
      "/services/:name",
      ({ params, status }) => {
        const removed = deps.registry.delete(params.name);
        if (!removed) return status(404, { error: "service not found" });
        return { ok: true };
      },
      { detail: { summary: "Delete a service (does not touch the cluster)", tags } },
    )
    .post(
      "/services/adopt",
      ({ body, status }) => {
        const parsed = AdoptBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const { name, namespace, clusterId, workloadKind, workloadName, containerName, imageRef, imagePullSecret } =
          parsed.data;
        if (!deps.clusters.get(clusterId)) return status(400, { error: `cluster '${clusterId}' not found` });
        try {
          const created = deps.registry.create({
            sourceType: "registry-pull",
            name: name ?? workloadName,
            namespace,
            clusterId,
            workloadKind,
            workloadName,
            containerName,
            imageRef,
            imagePullSecret,
            enabled: true,
          });
          // Pin it as an application so it never re-classifies as infrastructure on the next scan.
          deps.state.setWorkloadOverride(clusterId, namespace, workloadKind, workloadName, "application");
          return status(201, { service: created });
        } catch (e) {
          return status(409, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Adopt a cluster workload as a registry-pull service", tags } },
    )
    .get(
      "/services/:name/versions",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        if (svc.sourceType === "r2-bundle") {
          const versions = await listVersions(deps.r2Sources.clientFor(svc.r2SourceId), svc);
          return { items: versions, source: "r2" };
        }
        if (svc.sourceType === "git-sync") {
          // Re-validate the stored URL against the current allowlist before contacting the host.
          const v = validateGitUrl(svc.gitUrl, deps.cfg.git.hostAllowlist);
          if (!v.ok) return { items: [], source: "git", hint: v.error };
          // The deployable version is the tip of gitRef (the deploy shallow-clones --branch <ref>).
          const r = await deps.git.run(["ls-remote", "--", svc.gitUrl, svc.gitRef], { sshKey: svc.deployKeyPath });
          const sha = parseLsRemote(r.stdout);
          return { items: sha ? [{ tag: sha }] : [], source: "git", hint: sha ? null : r.stderr || "ls-remote returned no ref" };
        }
        const result = await listRegistryTags(svc.imageRef);
        const sorted = sortTagsDesc(result.tags).slice(0, 200);
        return {
          items: sorted.map((tag) => ({ tag })),
          source: "registry",
          rateLimited: result.rateLimited ?? false,
          authRequired: result.authRequired ?? false,
          hint: result.error ?? null,
          total: result.tags.length,
        };
      },
      { detail: { summary: "List deployable versions for a service", tags } },
    );
