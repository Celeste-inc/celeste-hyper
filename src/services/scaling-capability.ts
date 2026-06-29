export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

export interface PortSpec {
  containerPort: number;
  name?: string;
}

export interface ResourceList {
  cpu?: string;
  memory?: string;
  "ephemeral-storage"?: string;
}

export interface ContainerSpec {
  name: string;
  image: string;
  ports: PortSpec[];
  resources?: { requests?: ResourceList; limits?: ResourceList };
}

export interface VolumeSpec {
  name: string;
  persistentVolumeClaim?: { claimName: string };
}

export interface PvcInfo {
  name: string;
  storageClass: string | null;
  accessModes: string[];
  requested: string;
}

export interface StorageClassInfo {
  name: string;
  allowVolumeExpansion: boolean;
}

export interface ScalingInput {
  kind: WorkloadKind;
  containers: ContainerSpec[];
  volumes: VolumeSpec[];
  pvcs: PvcInfo[];
  storageClasses: StorageClassInfo[];
  replicas: number;
}

export interface PvcSummary extends PvcInfo {
  /** null when the storage class is unknown (treat as unknown — never silently true). */
  expandable: boolean | null;
}

export interface ScalingCapability {
  /** True iff replicas can scale out safely (HPA-eligible). */
  horizontal: boolean;
  /** True iff resource requests/limits can be bumped (always true for managed workloads). */
  vertical: boolean;
  /** Human-readable reasons feeding into the verdict — the UI surfaces these verbatim. */
  reasons: string[];
  /** Current resources of the primary container, surfaced so the UI can compute "+25 %". */
  resources: { requests: ResourceList; limits: ResourceList };
  pvcs: PvcSummary[];
}

// Well-known single-instance stateful images. Match on the image *name* (segment after the last /,
// up to ':') to avoid registry-host false positives. Patterns are *prefix* matches — `postgres-`
// images like postgres-exporter are explicitly excluded; check by exact match or strict prefix
// followed by ':' or end-of-string.
const STATEFUL_IMAGE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^postgres(?:[:@-]|$)/, label: "postgres" },
  { re: /^postgresql(?:[:@-]|$)/, label: "postgresql" },
  { re: /^mysql(?:[:@-]|$)/, label: "mysql" },
  { re: /^mariadb(?:[:@-]|$)/, label: "mariadb" },
  { re: /^mongo(?:db)?(?:[:@-]|$)/, label: "mongodb" },
  { re: /^mongodb-community-server(?:[:@-]|$)/, label: "mongodb" },
  { re: /^mssql/, label: "mssql" },
  { re: /^server(?:[:@-]|$)/, label: "mssql" }, // mcr.microsoft.com/mssql/server tail
  { re: /^redis(?:[:@-]|$)/, label: "redis" },
  { re: /^oracle\b/, label: "oracle" },
  { re: /^cockroachdb(?:[:@-]|$)/, label: "cockroachdb" },
  { re: /^elasticsearch(?:[:@-]|$)/, label: "elasticsearch" },
  { re: /^cassandra(?:[:@-]|$)/, label: "cassandra" },
];

// Ports the K8s ecosystem consistently associates with single-instance databases. Operator-deployed
// clusters override this via their own CRDs, so this only matters for hand-rolled images.
const STATEFUL_PORTS: Record<number, string> = {
  5432: "postgres",
  3306: "mysql",
  27017: "mongodb",
  1433: "mssql",
  1521: "oracle",
  6379: "redis",
};

function imageTail(image: string): string {
  // ghcr.io/foo/bar:tag → bar:tag → bar
  const noHost = image.split("/").pop() ?? image;
  return noHost.toLowerCase();
}

function matchesStatefulImage(image: string): string | null {
  const tail = imageTail(image);
  for (const { re, label } of STATEFUL_IMAGE_PATTERNS) {
    if (re.test(tail)) return label;
  }
  return null;
}

function matchesStatefulPort(containers: ContainerSpec[]): string | null {
  for (const c of containers) {
    for (const p of c.ports) {
      const label = STATEFUL_PORTS[p.containerPort];
      if (label) return `${p.containerPort} (${label})`;
    }
  }
  return null;
}

function mountsRwoPvc(volumes: VolumeSpec[], pvcs: PvcInfo[]): PvcInfo | null {
  for (const v of volumes) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = pvcs.find((p) => p.name === v.persistentVolumeClaim!.claimName);
    if (pvc && (pvc.accessModes.length === 0 || pvc.accessModes.every((m) => m === "ReadWriteOnce" || m === "ReadWriteOncePod"))) {
      return pvc;
    }
  }
  return null;
}

export function classifyScaling(input: ScalingInput): ScalingCapability {
  const reasons: string[] = [];
  let horizontal = true;

  if (input.kind === "StatefulSet") {
    horizontal = false;
    reasons.push(
      "StatefulSet replicas have ordinal identity and per-replica storage — scaling out is only safe under an operator (postgres-operator, mongodb-operator, etc.). Vertical scaling is supported.",
    );
  }

  if (input.kind === "DaemonSet") {
    horizontal = false;
    reasons.push("DaemonSet runs exactly one pod per node by definition — HPA is not applicable. Vertical scaling is supported.");
  }

  if (input.kind === "Deployment") {
    const rwo = mountsRwoPvc(input.volumes, input.pvcs);
    if (rwo) {
      horizontal = false;
      reasons.push(
        `PVC '${rwo.name}' is ReadWriteOnce — only one pod can mount it at a time. Use ReadWriteMany (NFS/Cluster FS) or split state into a dedicated database for horizontal scaling.`,
      );
    }
  }

  // Image / port heuristics flag single-instance databases even when no PVC is attached yet
  // (some operators bind storage later). Only fires for Deployments — StatefulSets already
  // tripped the kind rule above.
  if (horizontal) {
    const dbImage = input.containers.map((c) => matchesStatefulImage(c.image)).find((x): x is string => x !== null);
    if (dbImage) {
      horizontal = false;
      reasons.push(
        `Container image looks like ${dbImage} — single-instance databases are stateful and cannot scale horizontally. Use a clustered operator (e.g. CloudNativePG, MariaDB Operator) when you need multiple replicas.`,
      );
    } else {
      const dbPort = matchesStatefulPort(input.containers);
      if (dbPort) {
        horizontal = false;
        reasons.push(
          `Container exposes a known database port ${dbPort}. Treating as single-instance to avoid corruption; HPA disabled.`,
        );
      }
    }
  }

  const scByName = new Map(input.storageClasses.map((s) => [s.name, s]));
  const pvcs: PvcSummary[] = input.pvcs.map((p) => {
    if (!p.storageClass) return { ...p, expandable: null };
    const sc = scByName.get(p.storageClass);
    return { ...p, expandable: sc ? sc.allowVolumeExpansion : null };
  });

  const primary = input.containers[0];
  const resources = {
    requests: { ...(primary?.resources?.requests ?? {}) },
    limits: { ...(primary?.resources?.limits ?? {}) },
  };

  if (horizontal) reasons.push("Deployment without single-writer storage and no database fingerprint — safe to scale horizontally.");

  return { horizontal, vertical: true, reasons, resources, pvcs };
}
