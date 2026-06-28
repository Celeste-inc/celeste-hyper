export interface CrdEntry {
  name: string; // metadata.name, e.g. "certificates.cert-manager.io"
  group: string;
  version: string; // the storage (or first served) version
  kind: string;
  plural: string;
  scope: string; // "Namespaced" | "Cluster"
  namespaced: boolean;
}

export interface CrEntry {
  name: string;
  namespace: string | null;
  createdAt: string | null;
}

interface CrdItem {
  metadata?: { name?: string };
  spec?: {
    group?: string;
    names?: { kind?: string; plural?: string };
    scope?: string;
    versions?: Array<{ name?: string; served?: boolean; storage?: boolean }>;
  };
}

/** Parse `kubectl get crd -o json` → the served custom resource definitions. Tolerant; [] on garbage. */
export function parseCrdList(stdout: string): CrdEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: CrdEntry[] = [];
  for (const raw of items as CrdItem[]) {
    const name = raw.metadata?.name;
    const group = raw.spec?.group;
    const kind = raw.spec?.names?.kind;
    const plural = raw.spec?.names?.plural;
    if (!name || !group || !kind || !plural) continue;
    const versions = raw.spec?.versions ?? [];
    const version = (versions.find((v) => v.storage)?.name ?? versions.find((v) => v.served)?.name ?? versions[0]?.name) || "";
    const scope = raw.spec?.scope ?? "Namespaced";
    out.push({ name, group, version, kind, plural, scope, namespaced: scope === "Namespaced" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The kubectl resource selector for a CRD: `<plural>.<group>`. */
export function crdResource(crd: { plural: string; group: string }): string {
  return `${crd.plural}.${crd.group}`;
}

/** Parse `kubectl get <resource> -o json` (a list) → the object names/namespaces. Tolerant; [] on garbage. */
export function parseCrList(stdout: string): CrEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: CrEntry[] = [];
  for (const raw of items as Array<{ metadata?: { name?: string; namespace?: string; creationTimestamp?: string } }>) {
    const name = raw.metadata?.name;
    if (!name) continue;
    out.push({ name, namespace: raw.metadata?.namespace ?? null, createdAt: raw.metadata?.creationTimestamp ?? null });
  }
  return out;
}

const RESOURCE_RE = /^[a-z0-9][a-z0-9.-]*$/; // <plural>.<group>
const NAME_RE = /^[a-z0-9][a-z0-9.-]*$/;

export function isValidResource(resource: string): boolean {
  return RESOURCE_RE.test(resource) && resource.includes(".");
}
export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}
