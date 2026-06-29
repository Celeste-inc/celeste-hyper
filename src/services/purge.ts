import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceModel } from "./model.ts";
import { workloadNameFor, workloadKindFor, relatedWorkloadsFor } from "./model.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface IngressRef {
  ingressName: string;
}

export interface PurgeK8s {
  deleteWorkload(kind: string, name: string, namespace: string): Promise<RunResult>;
  kubectl(args: string[]): Promise<RunResult>;
  listIngressesFor(svcName: string, namespace: string): Promise<IngressRef[]>;
}

export interface PurgeOptions {
  k8s: PurgeK8s;
  envFilesDir?: string;
  dryRun?: boolean;
}

export interface PurgeStep {
  kind: "workload" | "service" | "configmap" | "secret" | "hpa" | "ingress" | "envFiles";
  resource: string;
  namespace?: string;
}

export interface PurgeFailure {
  resource: string;
  reason: string;
}

export interface PurgeResult {
  removed: string[];
  failed: PurgeFailure[];
  planned: string[];
}

function label(step: PurgeStep): string {
  switch (step.kind) {
    case "workload":
      return `${step.resource}`; // resource already encodes Kind/name
    case "service":
      return `Service/${step.resource}`;
    case "configmap":
      return `ConfigMap/${step.resource}`;
    case "secret":
      return `Secret/${step.resource}`;
    case "hpa":
      return `HPA/${step.resource}`;
    case "ingress":
      return `Ingress/${step.resource}`;
    case "envFiles":
      return `envFiles/${step.resource}`;
  }
}

function deleteArgs(kind: string, name: string, namespace: string): string[] {
  return ["-n", namespace, "delete", kind, "--ignore-not-found", "--", name];
}

async function execStep(
  k8s: PurgeK8s,
  step: PurgeStep,
  result: PurgeResult,
  dryRun: boolean,
): Promise<void> {
  const tag = label(step);
  result.planned.push(tag);
  if (dryRun) return;
  let r: RunResult;
  try {
    if (step.kind === "workload") {
      const [kind, name] = step.resource.split("/") as [string, string];
      r = await k8s.deleteWorkload(kind, name, step.namespace!);
    } else {
      r = await k8s.kubectl(deleteArgs(kindCli(step.kind), step.resource, step.namespace!));
    }
  } catch (e) {
    result.failed.push({ resource: tag, reason: (e as Error).message });
    return;
  }
  if (r.code === 0) {
    result.removed.push(tag);
  } else {
    result.failed.push({ resource: tag, reason: (r.stderr || r.stdout).trim().slice(0, 200) });
  }
}

function kindCli(kind: PurgeStep["kind"]): string {
  switch (kind) {
    case "service":
      return "service";
    case "configmap":
      return "configmap";
    case "secret":
      return "secret";
    case "hpa":
      return "hpa";
    case "ingress":
      return "ingress";
    default:
      throw new Error(`internal: unexpected kubectl kind ${kind}`);
  }
}

export async function purgeService(svc: ServiceModel, opts: PurgeOptions): Promise<PurgeResult> {
  const result: PurgeResult = { removed: [], failed: [], planned: [] };
  const dryRun = opts.dryRun === true;
  const k8s = opts.k8s;
  const ns = svc.namespace;
  const primaryName = workloadNameFor(svc);
  const primaryKind = workloadKindFor(svc);

  // 1. Workloads: primary + canary/green leftovers + declared related workloads.
  const workloadSteps: PurgeStep[] = [
    { kind: "workload", resource: `${primaryKind}/${primaryName}`, namespace: ns },
    { kind: "workload", resource: `Deployment/${svc.name}-canary`, namespace: ns },
    { kind: "workload", resource: `Deployment/${svc.name}-green`, namespace: ns },
    ...relatedWorkloadsFor(svc).map<PurgeStep>((rw) => ({
      kind: "workload",
      resource: `${rw.kind}/${rw.name}`,
      namespace: ns,
    })),
  ];

  // 2. Service object: prefer the workload name (what `expose` provisions); also try the svc.name as a fallback.
  const serviceSteps: PurgeStep[] = [{ kind: "service", resource: primaryName, namespace: ns }];
  if (primaryName !== svc.name) serviceSteps.push({ kind: "service", resource: svc.name, namespace: ns });

  // 3. ConfigMap + Secret created by env-files (`<service>-config` / `<service>-secret`).
  const cmSecretSteps: PurgeStep[] = [
    { kind: "configmap", resource: `${svc.name}-config`, namespace: ns },
    { kind: "secret", resource: `${svc.name}-secret`, namespace: ns },
  ];

  // 4. HPA targeting the workload — convention: same name as the workload.
  const hpaSteps: PurgeStep[] = [{ kind: "hpa", resource: primaryName, namespace: ns }];

  // 5. Ingresses referencing this Service object (best-effort discovery + delete).
  const ingressNames = await k8s
    .listIngressesFor(primaryName, ns)
    .catch(() => [] as IngressRef[]);
  // Dedup by name (same Ingress can have multiple paths).
  const uniqueIngressNames = [...new Set(ingressNames.map((i) => i.ingressName))];
  const ingressSteps: PurgeStep[] = uniqueIngressNames.map((name) => ({ kind: "ingress", resource: name, namespace: ns }));

  for (const step of [...workloadSteps, ...serviceSteps, ...cmSecretSteps, ...hpaSteps, ...ingressSteps]) {
    await execStep(k8s, step, result, dryRun);
  }

  // 6. Env files: <envFilesDir>/<service>/* — local filesystem, never reaches the cluster.
  if (opts.envFilesDir) {
    const dir = join(opts.envFilesDir, svc.name);
    const tag = label({ kind: "envFiles", resource: svc.name });
    result.planned.push(tag);
    if (!dryRun) {
      try {
        await rm(dir, { recursive: true, force: true });
        result.removed.push(tag);
      } catch (e) {
        result.failed.push({ resource: tag, reason: (e as Error).message });
      }
    }
  }

  return result;
}
