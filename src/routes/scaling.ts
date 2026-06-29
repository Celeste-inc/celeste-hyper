import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import { workloadKindFor, workloadNameFor, containerNameFor } from "../services/model.ts";
import { classifyScaling, type ScalingInput, type WorkloadKind } from "../services/scaling-capability.ts";
import { buildResourcesPatch, validateResources } from "../services/vertical-scale.ts";
import { buildPvcExpandPatch, validatePvcExpand } from "../services/pvc-expand.ts";

const RFC1123 = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

const ResourcesBody = z
  .object({
    requests: z
      .object({
        cpu: z.string().min(1).optional(),
        memory: z.string().min(1).optional(),
        "ephemeral-storage": z.string().min(1).optional(),
      })
      .optional(),
    limits: z
      .object({
        cpu: z.string().min(1).optional(),
        memory: z.string().min(1).optional(),
        "ephemeral-storage": z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();

const PvcExpandBody = z.object({ to: z.string().min(1).max(16) }).strict();

interface RawWorkload {
  kind: string;
  spec?: {
    replicas?: number;
    template?: {
      spec?: {
        containers?: Array<{
          name?: string;
          image?: string;
          ports?: Array<{ containerPort?: number; name?: string }>;
          resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
        }>;
        volumes?: Array<{ name?: string; persistentVolumeClaim?: { claimName?: string } }>;
      };
    };
  };
}

interface RawPvc {
  metadata?: { name?: string };
  spec?: { storageClassName?: string; accessModes?: string[]; resources?: { requests?: { storage?: string } } };
  status?: { capacity?: { storage?: string } };
}

interface RawStorageClass {
  metadata?: { name?: string };
  allowVolumeExpansion?: boolean;
}

async function loadScalingContext(deps: ApiDeps, svcName: string): Promise<
  | { error: number; message: string }
  | { ok: true; svc: ReturnType<typeof deps.registry.get>; k8s: NonNullable<ReturnType<typeof deps.pool.get>>; kind: WorkloadKind; input: ScalingInput }
> {
  const svc = deps.registry.get(svcName);
  if (!svc) return { error: 404, message: "service not found" };
  const k8s = deps.pool.get(svc.clusterId);
  if (!k8s) return { error: 500, message: `cluster '${svc.clusterId}' not configured` };
  const kind = workloadKindFor(svc) as WorkloadKind;
  const wlR = await k8s.kubectl(["-n", svc.namespace, "get", kind.toLowerCase(), "-o", "json", "--", workloadNameFor(svc)]);
  if (wlR.code !== 0) return { error: 502, message: (wlR.stderr || wlR.stdout).trim().slice(0, 200) };
  let workload: RawWorkload;
  try {
    workload = JSON.parse(wlR.stdout) as RawWorkload;
  } catch (e) {
    return { error: 502 as const, message: `kubectl returned non-JSON: ${(e as Error).message}` };
  }
  const containers = (workload.spec?.template?.spec?.containers ?? []).map((c) => ({
    name: c.name ?? "",
    image: c.image ?? "",
    ports: (c.ports ?? []).map((p) => ({ containerPort: p.containerPort ?? 0, name: p.name })),
    resources: c.resources,
  }));
  const volumes = (workload.spec?.template?.spec?.volumes ?? []).map((v) => ({
    name: v.name ?? "",
    persistentVolumeClaim: v.persistentVolumeClaim?.claimName ? { claimName: v.persistentVolumeClaim.claimName } : undefined,
  }));
  // Pull every PVC in the namespace; the classifier picks the ones the volumes reference.
  const pvcR = await k8s.kubectl(["-n", svc.namespace, "get", "pvc", "-o", "json"]);
  const pvcs = pvcR.code === 0
    ? ((JSON.parse(pvcR.stdout) as { items?: RawPvc[] }).items ?? []).map((p) => ({
        name: p.metadata?.name ?? "",
        storageClass: p.spec?.storageClassName ?? null,
        accessModes: p.spec?.accessModes ?? [],
        requested: p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage ?? "0",
      }))
    : [];
  // StorageClasses are cluster-scoped — list once for the cluster.
  const scR = await k8s.kubectl(["get", "storageclasses", "-o", "json"]);
  const storageClasses = scR.code === 0
    ? ((JSON.parse(scR.stdout) as { items?: RawStorageClass[] }).items ?? []).map((s) => ({
        name: s.metadata?.name ?? "",
        allowVolumeExpansion: s.allowVolumeExpansion === true,
      }))
    : [];
  const input: ScalingInput = {
    kind,
    containers,
    volumes,
    pvcs,
    storageClasses,
    replicas: workload.spec?.replicas ?? 1,
  };
  return { ok: true as const, svc, k8s, kind, input };
}

export const scalingRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/services/:name/scaling-capability",
      async ({ params, status }) => {
        const ctx = await loadScalingContext(deps, params.name);
        if ("error" in ctx) return status(ctx.error as number, { error: ctx.message });
        return classifyScaling(ctx.input);
      },
      { detail: { summary: "Identify whether a workload can scale horizontally or only vertically (and why)", tags: ["scaling"] } },
    )
    .patch(
      "/services/:name/resources",
      async ({ params, body, status }) => {
        const parsed = ResourcesBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const err = validateResources(parsed.data);
        if (err) return status(422, { error: err });
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });
        const patch = buildResourcesPatch({
          containerName: containerNameFor(svc),
          requests: parsed.data.requests,
          limits: parsed.data.limits,
        });
        const kind = workloadKindFor(svc).toLowerCase();
        const r = await k8s.kubectl([
          "-n", svc.namespace, "patch", kind, "--type=strategic", "-p", JSON.stringify(patch), "--", workloadNameFor(svc),
        ]);
        if (r.code !== 0) return status(502, { error: (r.stderr || r.stdout).trim().slice(0, 200) });
        return { ok: true, requests: parsed.data.requests ?? {}, limits: parsed.data.limits ?? {}, message: "k8s will roll one pod at a time with the new resource envelope." };
      },
      { detail: { summary: "Vertical scale — patch container CPU/memory/ephemeral-storage requests + limits", tags: ["scaling"] } },
    )
    .patch(
      "/services/:name/pvcs/:pvc",
      async ({ params, body, status }) => {
        const parsed = PvcExpandBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        if (!RFC1123.test(params.pvc)) return status(400, { error: "invalid pvc name" });
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });
        // Read the current PVC and its storageClass to decide whether the call is even sane.
        const pvcR = await k8s.kubectl(["-n", svc.namespace, "get", "pvc", "-o", "json", "--", params.pvc]);
        if (pvcR.code !== 0) return status(404, { error: `pvc '${params.pvc}' not found` });
        let pvc: RawPvc;
        try {
          pvc = JSON.parse(pvcR.stdout) as RawPvc;
        } catch (e) {
          return status(502, { error: `kubectl returned non-JSON: ${(e as Error).message}` });
        }
        const currentSize = pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage ?? "0";
        let expandable: boolean | null = null;
        const scName = pvc.spec?.storageClassName;
        if (scName) {
          const scR = await k8s.kubectl(["get", "storageclass", "-o", "json", "--", scName]);
          if (scR.code === 0) {
            try {
              const sc = JSON.parse(scR.stdout) as RawStorageClass;
              expandable = sc.allowVolumeExpansion === true;
            } catch {
              // unknown shape — leave null and let validate decide
            }
          }
        }
        const err = validatePvcExpand({ from: currentSize, to: parsed.data.to, expandable });
        if (err) return status(422, { error: err });
        const patch = buildPvcExpandPatch(parsed.data.to);
        const r = await k8s.kubectl([
          "-n", svc.namespace, "patch", "pvc", "--type=strategic", "-p", JSON.stringify(patch), "--", params.pvc,
        ]);
        if (r.code !== 0) return status(502, { error: (r.stderr || r.stdout).trim().slice(0, 200) });
        return {
          ok: true,
          pvc: params.pvc,
          from: currentSize,
          to: parsed.data.to,
          message: "Online expansion requested. The CSI driver resizes the volume; the pod may need a rollout restart for the filesystem to pick up the new size (ext4/xfs grow online automatically on most drivers).",
        };
      },
      { detail: { summary: "Expand a PVC online (StorageClass must have allowVolumeExpansion: true)", tags: ["scaling"] } },
    );
