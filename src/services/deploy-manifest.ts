// Pure manifest transforms for canary / blue-green deploy modes (P1.7). Operate on the JSON of an
// existing Deployment and produce a sibling Deployment manifest, stripping server-managed fields.

interface DeploymentManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; [k: string]: unknown };
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    strategy?: unknown;
    template?: { metadata?: { labels?: Record<string, string> }; spec?: { containers?: { name?: string; image?: string }[] } };
    [k: string]: unknown;
  };
  status?: unknown;
}

const SERVER_FIELDS = ["resourceVersion", "uid", "creationTimestamp", "generation", "managedFields"];
// Only the server-managed annotations are dropped; operator annotations are preserved.
const SERVER_ANNOTATIONS = ["kubectl.kubernetes.io/last-applied-configuration", "deployment.kubernetes.io/revision"];

function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

function stripServerFields(m: DeploymentManifest): void {
  delete m.status;
  if (!m.metadata) return;
  for (const f of SERVER_FIELDS) delete (m.metadata as Record<string, unknown>)[f];
  const annotations = (m.metadata as { annotations?: Record<string, string> }).annotations;
  if (annotations) for (const a of SERVER_ANNOTATIONS) delete annotations[a];
}

function setContainerImage(m: DeploymentManifest, container: string, image: string): void {
  const containers = m.spec?.template?.spec?.containers ?? [];
  const c = containers.find((x) => x.name === container) ?? containers[0];
  if (c) c.image = image;
}

/**
 * Build a canary Deployment from the live one: a sibling named `<name>-canary` with the new image,
 * `replicas` pods, and an extra distinguishing label on its selector + pod template (so it gets its
 * own ReplicaSet). It KEEPS the app labels, so the Service still routes a fraction of traffic to it.
 */
export function buildCanaryManifest(
  base: DeploymentManifest,
  canaryName: string,
  container: string,
  image: string,
  replicas: number,
): DeploymentManifest {
  const m = clone(base);
  m.apiVersion = base.apiVersion ?? "apps/v1";
  m.kind = "Deployment";
  m.metadata = { ...m.metadata, name: canaryName };
  stripServerFields(m);
  m.spec = m.spec ?? {};
  m.spec.replicas = replicas;
  const mark = { "celeste-hyper/canary": canaryName };
  m.spec.selector = { matchLabels: { ...(m.spec.selector?.matchLabels ?? {}), ...mark } };
  m.spec.template = m.spec.template ?? {};
  m.spec.template.metadata = { ...m.spec.template.metadata, labels: { ...(m.spec.template?.metadata?.labels ?? {}), ...mark } };
  setContainerImage(m, container, image);
  return m;
}

/**
 * Build a colored Deployment (blue-green) with a FRESH label set so the live Service (still on the
 * old selector) does not route to it until the selector is flipped — no pre-cutover traffic split.
 */
export function buildColorManifest(
  base: DeploymentManifest,
  coloredName: string,
  serviceName: string,
  container: string,
  image: string,
  color: string,
): { manifest: DeploymentManifest; labels: Record<string, string> } {
  const labels = { "celeste-hyper/managed": serviceName, "celeste-hyper/color": color };
  const m = clone(base);
  m.apiVersion = base.apiVersion ?? "apps/v1";
  m.kind = "Deployment";
  m.metadata = { ...m.metadata, name: coloredName, labels };
  stripServerFields(m);
  m.spec = m.spec ?? {};
  // Never clone 0 replicas: a repeated blue-green reads the already-drained blue (replicas:0); a
  // 0-replica green would pass `rollout status` instantly and black-hole traffic after the flip.
  m.spec.replicas = Math.max(1, m.spec.replicas ?? 1);
  m.spec.selector = { matchLabels: labels };
  m.spec.template = m.spec.template ?? {};
  m.spec.template.metadata = { ...m.spec.template.metadata, labels };
  setContainerImage(m, container, image);
  return { manifest: m, labels };
}
