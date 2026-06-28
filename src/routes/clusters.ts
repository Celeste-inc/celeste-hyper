import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import { CreateClusterSchema, UpdateClusterSchema } from "../services/model.ts";
import { parseCrdList, parseCrList, isValidResource, isValidName } from "../services/crds.ts";
import { evaluateSkew } from "../lib/kube-version.ts";

// RFC-1123 name guard. Used by the ingress route (also blocks a `--flag`-style value reaching
// kubectl as a flag) and the override route (blocks dead overrides that can't match a real key).
const K8S_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** True iff `<plural>.<group>` names a registered CustomResourceDefinition (its metadata.name) — so
 *  the CR endpoints can't be pointed at core resources like `secrets.` to read non-CRD data. */
async function isRegisteredCrd(k8s: { kubectl(args: string[]): Promise<{ code: number }> }, resource: string): Promise<boolean> {
  const r = await k8s.kubectl(["get", "crd", "-o", "name", "--request-timeout=10s", "--", resource]);
  return r.code === 0;
}

const WorkloadOverrideBody = z.object({
  namespace: z.string().regex(K8S_NAME),
  kind: z.enum(["Deployment", "StatefulSet", "DaemonSet"]),
  name: z.string().regex(K8S_NAME),
  category: z.enum(["application", "infrastructure"]),
});

const tags = ["clusters"];

export const clusterRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/clusters",
      () => {
        const snap = deps.poller.getSnapshot();
        const kubectlVersion = deps.capabilities.kubectlVersion();
        const items = deps.clusters.list().map((cl) => {
          const health = deps.pool.getHealth(cl.id);
          const serviceCount = deps.state.countServicesByCluster(cl.id);
          const { capabilities, lastCheckedAt, serverVersion } = deps.capabilities.merged(cl.id);
          // kubectl<->apiserver minor skew (CC.5): ok/null until both versions are known.
          const versionSkew = evaluateSkew(kubectlVersion, serverVersion);
          return { ...cl, health, serviceCount, capabilities, capabilitiesCheckedAt: lastCheckedAt, kubectlVersion, serverVersion, versionSkew };
        });
        return { items };
      },
      { detail: { summary: "List clusters with health and service counts", tags } },
    )
    .post(
      "/clusters",
      async ({ body, status }) => {
        const parsed = CreateClusterSchema.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        try {
          const created = deps.clusters.create(parsed.data);
          deps.pool.invalidate(created.id);
          await deps.capabilities.refreshCluster(created.id); // registration probe
          return status(201, { cluster: created });
        } catch (e) {
          return status(409, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Register a cluster", tags } },
    )
    .patch(
      "/clusters/:id",
      async ({ params, body, status }) => {
        const parsed = UpdateClusterSchema.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        try {
          const updated = deps.clusters.update(params.id, parsed.data);
          deps.pool.invalidate(updated.id);
          await deps.capabilities.refreshCluster(updated.id); // kubeconfig/runtime may have changed
          return { cluster: updated };
        } catch (e) {
          return status(400, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Update a cluster", tags } },
    )
    .delete(
      "/clusters/:id",
      ({ params, status }) => {
        try {
          const removed = deps.clusters.delete(params.id);
          if (!removed) return status(404, { error: "cluster not found" });
          deps.pool.invalidate(params.id);
          deps.capabilities.invalidate(params.id);
          return { ok: true };
        } catch (e) {
          return status(409, { error: (e as Error).message });
        }
      },
      { detail: { summary: "Delete a cluster", tags } },
    )
    .post(
      "/clusters/:id/check",
      async ({ params }) => {
        const [health] = await Promise.all([deps.pool.checkHealth(params.id), deps.capabilities.refreshCluster(params.id)]);
        return { health, ...deps.capabilities.merged(params.id) };
      },
      { detail: { summary: "Force a cluster health + capability check", tags } },
    )
    .get(
      "/clusters/:id/ingresses/:namespace/:name",
      async ({ params, status }) => {
        if (!K8S_NAME.test(params.namespace) || !K8S_NAME.test(params.name)) {
          return status(400, { error: "invalid namespace or ingress name" });
        }
        const k8s = deps.pool.get(params.id);
        if (!k8s) return status(404, { error: "cluster not found" });
        const r = await k8s.getIngressYaml(params.name, params.namespace);
        if (r.code !== 0) return status(404, { error: "ingress not found" });
        return { yaml: r.stdout };
      },
      { detail: { summary: "Raw YAML of an Ingress object (operator+; viewer forbidden)", tags } },
    )
    // ── Custom resources (P3.1, operator-gated — raw cluster objects) ──
    .get(
      "/clusters/:id/crds",
      async ({ params, status }) => {
        const k8s = deps.pool.get(params.id);
        if (!k8s) return status(404, { error: "cluster not found" });
        const r = await k8s.kubectl(["get", "crd", "-o", "json", "--request-timeout=10s"]);
        if (r.code !== 0) return status(502, { error: (r.stderr || r.stdout).trim().slice(0, 200) });
        return { items: parseCrdList(r.stdout) };
      },
      { detail: { summary: "List the cluster's CustomResourceDefinitions (operator+)", tags } },
    )
    .get(
      "/clusters/:id/crds/:resource/objects",
      async ({ params, query, status }) => {
        if (!isValidResource(params.resource)) return status(400, { error: "invalid resource" });
        const k8s = deps.pool.get(params.id);
        if (!k8s) return status(404, { error: "cluster not found" });
        // Confine to ACTUAL CRDs — otherwise `:resource` like `secrets.` would read core Secrets
        // (and the yaml route would leak their data) through this endpoint.
        if (!(await isRegisteredCrd(k8s, params.resource))) return status(404, { error: "not a custom resource definition" });
        const ns = query.namespace;
        if (ns !== undefined && !K8S_NAME.test(ns)) return status(400, { error: "invalid namespace" });
        const args = ns ? ["-n", ns, "get", params.resource, "-o", "json"] : ["get", params.resource, "--all-namespaces", "-o", "json"];
        const r = await k8s.kubectl([...args, "--request-timeout=10s"]);
        if (r.code !== 0) return status(502, { error: (r.stderr || r.stdout).trim().slice(0, 200) });
        return { items: parseCrList(r.stdout) };
      },
      { detail: { summary: "List objects of a custom resource kind (operator+)", tags } },
    )
    .get(
      "/clusters/:id/crds/:resource/objects/:name/yaml",
      async ({ params, query, status }) => {
        if (!isValidResource(params.resource)) return status(400, { error: "invalid resource" });
        if (!isValidName(params.name)) return status(400, { error: "invalid object name" });
        const k8s = deps.pool.get(params.id);
        if (!k8s) return status(404, { error: "cluster not found" });
        if (!(await isRegisteredCrd(k8s, params.resource))) return status(404, { error: "not a custom resource definition" });
        const ns = query.namespace;
        if (ns !== undefined && !K8S_NAME.test(ns)) return status(400, { error: "invalid namespace" });
        const nsArgs = ns ? ["-n", ns] : [];
        // `--` terminates flag parsing so a `-`-leading name can't be read as a flag (defense in depth).
        const r = await k8s.kubectl([...nsArgs, "get", params.resource, "-o", "yaml", "--request-timeout=10s", "--", params.name]);
        if (r.code !== 0) return status(404, { error: "object not found" });
        return { yaml: r.stdout };
      },
      { detail: { summary: "Raw YAML of a custom resource object (operator+)", tags } },
    )
    .get(
      "/clusters/:id/namespaces",
      async ({ params, status }) => {
        const k8s = deps.pool.get(params.id);
        if (!k8s) return status(404, { error: "cluster not found" });
        try {
          return await k8s.namespaceCounts();
        } catch (e) {
          return status(502, { items: [], truncated: false, error: (e as Error).message });
        }
      },
      { detail: { summary: "Namespaces in a cluster with pod/workload counts", tags } },
    )
    .post(
      "/clusters/:id/workload-overrides",
      ({ params, body, status }) => {
        if (!deps.clusters.get(params.id)) return status(404, { error: "cluster not found" });
        const parsed = WorkloadOverrideBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const { namespace, kind, name, category } = parsed.data;
        deps.state.setWorkloadOverride(params.id, namespace, kind, name, category);
        return { ok: true };
      },
      { detail: { summary: "Override a discovered workload's classification (operator+)", tags } },
    );
