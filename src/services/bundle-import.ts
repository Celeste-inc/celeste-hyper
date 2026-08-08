// P4.3 — Remote r2-bundle image delivery.
//
// When a cluster is a *remote* machine (`imageLoad: "remote-pull"`), the master cannot `ctr import`
// the bundle tar into the node's containerd (that only works when hyper runs ON the node). Instead we
// run a one-shot, privileged in-cluster Job on the target cluster that, in a single container:
//   1. curls the bundle tar from a short-lived presigned R2 URL into a scratch emptyDir — the URL is
//      passed via ENV, never as a container argument, so it can't leak through the pod/process argv;
//   2. runs `k3s ctr -n k8s.io images import` against the node's containerd socket, loading the image
//      into the exact store kubelet pulls from — so the bundle's `imagePullPolicy: Never` pod finds it.
//
// The `ctr` binary comes from the NODE's own k3s binary (hostPath-mounted, static, exact-version match
// with the node's containerd) rather than a ~250 MB `rancher/k3s` image pull — the container image is
// only a tiny TLS-capable fetcher. The node pulls the bundle itself ("the R2 files land on the other
// machine") and no registry credentials ever touch the cluster.
//
// Multi-node clusters get one Job PER Ready+schedulable Linux node (`spec.nodeName`-pinned), because a
// containerd image store is node-local: importing on a single arbitrary node would leave every other
// node unable to run the bundle's `imagePullPolicy: Never` pods (ImagePullBackOff on scale-out or
// reschedule). Listing nodes needs cluster-scoped RBAC (`list nodes`); when the kubeconfig is
// forbidden from that, we fall back to the original single unpinned Job — identical to the
// pre-multi-node behavior. Any OTHER node-list failure (timeout, partition) fails the deploy instead
// of silently importing to a single node.

import { createHash } from "node:crypto";
import { log } from "../lib/logger.ts";

/** Default k3s containerd socket. Vanilla containerd is `/run/containerd/containerd.sock`; k3s is the
 *  enrolled-worker default, so it is the builder default (overridable per call). */
export const K3S_CONTAINERD_SOCKET = "/run/k3s/containerd/containerd.sock";
/** Standard k3s binary path (get.k3s.io + join.sh both install here). Hosts the `ctr` multicall. */
export const K3S_HOST_BINARY = "/usr/local/bin/k3s";

// Tiny, TLS-capable fetch image (curl over https for real R2 / http for a local S3 stand-in).
const DEFAULT_FETCH_IMAGE = "curlimages/curl:8.11.1";
export const DEFAULT_DEADLINE_SEC = 600;
const TTL_AFTER_FINISHED_SEC = 300;
const DEFAULT_POLL_TICK_MS = 2000;
// Concurrent kubectl child processes per fan-out (delete / per-tick polling). Keeps a large cluster
// from spawning N simultaneous processes on the master host.
const MAX_KUBECTL_CONCURRENCY = 8;
// A Job whose status read fails this many ticks IN A ROW is treated as lost (RBAC revoked mid-flight,
// TTL-reaped, deleted out-of-band) — fail fast instead of burning the whole poll budget.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

export interface BundleImportSpec {
  service: string;
  namespace: string;
  tag: string;
  /** Short-TTL presigned R2 GET URL for the image tar. Passed to the Job via env, never argv. */
  tarUrl: string;
  socketPath?: string;
  /** Node path of the k3s binary to hostPath-mount for `ctr` (default `/usr/local/bin/k3s`). */
  k3sBinaryPath?: string;
  fetchImage?: string;
  deadlineSec?: number;
  /** Pin the Job's pod to this node (`spec.nodeName` — bypasses the scheduler). Unset = unpinned. */
  nodeName?: string;
}

/** Lowercase to `[a-z0-9-]`, collapsing runs and trimming dashes — safe for a k8s name/label segment. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Node segment for a per-node Job name. Injective: a name passes through verbatim only when slugging
 *  changed nothing AND it is short enough to never overlap the hashed form (17 < 17+1+6); everything
 *  else gets a stable prefix + content hash, so two distinct nodes (`node.a` vs `node-a`, long names,
 *  truncations) can never produce the same segment. */
function nodeSegment(node: string): string {
  const s = slug(node);
  if (s.length <= 17 && s === node) return s;
  const h = createHash("sha256").update(node).digest("hex").slice(0, 6);
  return `${s.slice(0, 17)}-${h}`;
}

/** Deterministic, RFC-1123-safe (≤63 char) Job name for a service+tag (+optional node) import. */
export function importJobName(service: string, tag: string, node?: string): string {
  const seg = node ? nodeSegment(node) : "";
  const budget = 62 - (seg ? seg.length + 1 : 0);
  const base = `celeste-import-${slug(service)}-${slug(tag)}`.slice(0, budget).replace(/-+$/g, "");
  const full = seg ? `${base}-${seg}` : base;
  return full.replace(/^-+|-+$/g, "") || "celeste-import";
}

/** A valid (≤63-char, dash-trimmed) label value for a service name. */
function serviceLabel(service: string): string {
  return slug(service).slice(0, 63).replace(/-+$/g, "") || "unknown";
}

/** Bounds every request to the (possibly remote / partitioned) apiserver, so a network stall on the
 *  remote node surfaces as a bounded failure the retry logic can act on — never a hang that would wedge
 *  the single-threaded deploy worker. */
const REQ_TIMEOUT = "--request-timeout=20s";

/** The remote import talks to the cluster through a single, always-timeout-bounded `kubectl` seam. */
export interface ImportK8s {
  kubectl(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface RemoteImportArgs {
  k8s: ImportK8s;
  presignedUrl: string;
  service: string;
  namespace: string;
  tag: string;
  /** Injected so the poll loop is clock-controlled in tests (no real waiting). */
  delay: (ms: number) => Promise<void>;
  pollTicks?: number;
  tickMs?: number;
  socketPath?: string;
  /** Job wall-clock budget; also drives the default poll-tick budget (single source of truth). */
  deadlineSec?: number;
  /** Injected clock for the wall-clock poll bound (tests pin it; default `Date.now`). */
  now?: () => number;
  /** Live progress line for the deploy status stream (per-node import completions). */
  onProgress?: (message: string) => void;
}

/** Map with bounded concurrency — each fn spawns a kubectl child process, so an unbounded
 *  `Promise.all` over a large node list would fork N processes at once on the master host. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Best-effort delete of the import Job (idempotent, bounded). Never throws. */
async function deleteJob(k8s: ImportK8s, name: string, namespace: string): Promise<void> {
  await k8s.kubectl(["-n", namespace, "delete", "job", "--ignore-not-found", REQ_TIMEOUT, "--", name]).catch(() => {});
}

/** Best-effort tail of the import Job's pod logs (for a failure message). Never throws. */
async function captureJobLogs(k8s: ImportK8s, name: string, namespace: string): Promise<string> {
  try {
    const r = await k8s.kubectl(["-n", namespace, "logs", `job/${name}`, "--tail=20", "--all-containers=true", REQ_TIMEOUT]);
    const text = (r.stdout || r.stderr).trim().replace(/\s+/g, " ");
    return text ? text.slice(0, 300) : "";
  } catch {
    return "";
  }
}

interface RawNodeList {
  items?: {
    metadata?: { name?: string };
    spec?: { unschedulable?: boolean };
    status?: {
      conditions?: { type?: string; status?: string }[];
      nodeInfo?: { operatingSystem?: string };
    };
  }[];
}

type NodeListResult = { ok: true; nodes: string[] } | { ok: false; forbidden: boolean; message: string };

/** Names of every Ready, schedulable Linux node — each must receive the image (containerd stores are
 *  node-local). Distinguishes "forbidden" (namespace-scoped RBAC — caller falls back to the original
 *  single unpinned Job) from transient failures (timeout, partition, garbled read — caller must fail
 *  the deploy rather than silently import to one node). Never throws. */
async function listImportNodes(k8s: ImportK8s): Promise<NodeListResult> {
  let r: { code: number; stdout: string; stderr: string };
  try {
    r = await k8s.kubectl(["get", "nodes", "-o", "json", REQ_TIMEOUT]);
  } catch (e) {
    return { ok: false, forbidden: false, message: (e as Error).message.slice(0, 200) };
  }
  if (r.code !== 0) {
    const stderr = (r.stderr || r.stdout).trim();
    const forbidden = /forbidden|cannot list resource "nodes"|unauthorized/i.test(stderr);
    return { ok: false, forbidden, message: stderr.slice(0, 200) };
  }
  try {
    const parsed = JSON.parse(r.stdout) as RawNodeList;
    const nodes = (parsed.items ?? [])
      .filter((n) => n.metadata?.name && n.spec?.unschedulable !== true)
      .filter((n) => (n.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"))
      // hostPath k3s binary + containerd socket only exist on Linux nodes; absent nodeInfo = include
      // (k3s always reports it; only an explicit non-linux OS is excluded).
      .filter((n) => (n.status?.nodeInfo?.operatingSystem ?? "linux") === "linux")
      .map((n) => n.metadata!.name!)
      .sort();
    return { ok: true, nodes };
  } catch {
    return { ok: false, forbidden: false, message: "node list returned non-JSON output" };
  }
}

/** Apply one import Job per Ready+schedulable node (single unpinned Job when node-listing is
 *  RBAC-forbidden), poll all of them to completion, and always tear every one down. The image must
 *  land on EVERY node — one failure fails the deploy, because a node without the image cannot run the
 *  bundle's `imagePullPolicy: Never` pods. Pure orchestration over the injected K8s + delay —
 *  unit-tested with fakes. Every apiserver call is timeout-bounded (`REQ_TIMEOUT`) so a partitioned
 *  remote node can't hang the deploy worker. */
export async function runRemoteBundleImport(args: RemoteImportArgs): Promise<{ ok: boolean; message: string }> {
  const { k8s, presignedUrl, service, namespace, tag, delay } = args;
  const deadlineSec = args.deadlineSec ?? DEFAULT_DEADLINE_SEC;
  const now = args.now ?? (() => Date.now());
  const listed = await listImportNodes(k8s);
  if (!listed.ok && !listed.forbidden) {
    log.warn("bundle-import.node-list-failed", { service, tag, message: listed.message });
    return { ok: false, message: `list nodes: ${listed.message}` };
  }
  if (!listed.ok) {
    log.warn("bundle-import.node-list-forbidden", { service, tag, message: listed.message });
  }
  const nodes = listed.ok ? listed.nodes : [];
  const targets: { name: string; node?: string }[] =
    nodes.length > 0
      ? nodes.map((node) => ({ name: importJobName(service, tag, node), node }))
      : [{ name: importJobName(service, tag) }];
  if (new Set(targets.map((t) => t.name)).size !== targets.length) {
    return { ok: false, message: `internal: duplicate import Job names for nodes [${nodes.join(", ")}]` };
  }
  log.info("bundle-import.start", { service, tag, jobs: targets.length, pinned: nodes.length > 0 });
  const progress = args.onProgress ?? (() => {});
  progress(
    nodes.length > 0
      ? `importing image on ${targets.length} node(s): ${nodes.join(", ")}`
      : "importing image via in-cluster Job",
  );
  const teardownAll = async () => {
    await mapBounded(targets, MAX_KUBECTL_CONCURRENCY, (t) => deleteJob(k8s, t.name, namespace));
  };
  // A Job's pod template is immutable, so a leftover Job from a crashed/retried attempt would make
  // `apply` fail. Delete any prior instance first (idempotent) so retries are clean.
  await teardownAll();
  for (const t of targets) {
    const job = buildBundleImportJob({
      service,
      namespace,
      tag,
      tarUrl: presignedUrl,
      socketPath: args.socketPath,
      deadlineSec,
      nodeName: t.node,
    });
    const applied = await k8s.kubectl(["-n", namespace, "apply", "-f", "-", REQ_TIMEOUT], JSON.stringify(job));
    if (applied.code !== 0) {
      // The create may have raced (accepted server-side, error on the client read), so tear down before
      // returning — never leave an unmonitored privileged Job behind.
      await teardownAll();
      return { ok: false, message: `apply import job${t.node ? ` (node ${t.node})` : ""}: ${(applied.stderr || applied.stdout).trim().slice(0, 200)}` };
    }
  }
  try {
    const tickMs = args.tickMs ?? DEFAULT_POLL_TICK_MS;
    // Poll PAST the Job's own activeDeadlineSeconds (+60s margin) so a slow-but-valid import is
    // observed as the Job's DeadlineExceeded (status.failed), never abandoned + torn down early.
    // Bounded BOTH by tick count and wall clock: per-tick cost grows with node count (N kubectl
    // reads), so a fixed tick count alone would overrun the intended budget on large clusters.
    const budgetMs = (deadlineSec + 60) * 1000;
    const startedAt = now();
    const ticks = args.pollTicks ?? Math.ceil(budgetMs / tickMs);
    const pending = new Map(targets.map((t) => [t.name, { node: t.node, errors: 0 }]));
    for (let i = 0; i < ticks && now() - startedAt <= budgetMs; i++) {
      const snapshot = [...pending.entries()];
      const reads = await mapBounded(snapshot, MAX_KUBECTL_CONCURRENCY, async ([name]) =>
        k8s.kubectl(["-n", namespace, "get", "job", "-o", "json", REQ_TIMEOUT, "--", name]),
      );
      for (let j = 0; j < snapshot.length; j++) {
        const [name, meta] = snapshot[j]!;
        const r = reads[j]!;
        if (r.code !== 0) {
          // Transient apiserver hiccups are tolerated, but a Job whose reads fail persistently is
          // lost (RBAC revoked, TTL-reaped, deleted out-of-band) — waiting out the budget helps nobody.
          if (++meta.errors > MAX_CONSECUTIVE_POLL_ERRORS) {
            return { ok: false, message: `import Job/${name} unreadable after ${MAX_CONSECUTIVE_POLL_ERRORS} attempts: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
          }
          continue;
        }
        meta.errors = 0;
        let status: { succeeded?: number; failed?: number } = {};
        try {
          status = (JSON.parse(r.stdout) as { status?: typeof status }).status ?? {};
        } catch {
          // a transient non-JSON read — keep polling
        }
        if ((status.succeeded ?? 0) >= 1) {
          log.info("bundle-import.node-done", { service, tag, node: meta.node ?? null });
          pending.delete(name);
          if (meta.node) progress(`image imported on ${meta.node} (${targets.length - pending.size}/${targets.length})`);
          continue;
        }
        if ((status.failed ?? 0) >= 1) {
          // Capture the pod's logs BEFORE the finally block tears the Job down (else the operator sees
          // only "failed" with no cause).
          const tail = await captureJobLogs(k8s, name, namespace);
          const where = meta.node ? `node ${meta.node}` : "the node";
          return { ok: false, message: `import Job/${name} failed on ${where}${tail ? `: ${tail}` : ""}` };
        }
      }
      if (pending.size === 0) {
        return targets[0]?.node
          ? { ok: true, message: `imported on ${targets.length} node(s): ${targets.map((t) => t.node).join(", ")}` }
          : { ok: true, message: `imported on the node via Job/${targets[0]!.name}` };
      }
      await delay(tickMs);
    }
    return { ok: false, message: `import Job(s) [${[...pending.keys()].join(", ")}] did not complete in time` };
  } finally {
    await teardownAll();
  }
}

/** Build the one-shot privileged image-import Job manifest (a plain object; the deployer JSON-encodes
 *  it for `kubectl apply -f -`). All hardening (no retries, deadline, self-delete, no SA token, URL via
 *  env) is baked in here so it is reviewed + tested in one pure place. */
export function buildBundleImportJob(spec: BundleImportSpec): object {
  const socket = spec.socketPath ?? K3S_CONTAINERD_SOCKET;
  const k3sBin = spec.k3sBinaryPath ?? K3S_HOST_BINARY;
  const name = importJobName(spec.service, spec.tag, spec.nodeName);
  const tarPath = "/work/image.tar";
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: spec.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "celeste-hyper",
        "celeste-hyper.io/role": "bundle-import",
        "celeste-hyper.io/service": serviceLabel(spec.service),
      },
    },
    spec: {
      backoffLimit: 0, // a failed import must not silently re-run and race the deploy
      activeDeadlineSeconds: spec.deadlineSec ?? DEFAULT_DEADLINE_SEC,
      ttlSecondsAfterFinished: TTL_AFTER_FINISHED_SEC, // belt-and-suspenders cleanup if the deployer dies
      template: {
        metadata: { labels: { "app.kubernetes.io/managed-by": "celeste-hyper", "celeste-hyper.io/role": "bundle-import" } },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          // `nodeName` bypasses the scheduler (NoSchedule taints don't apply), but a NoExecute taint
          // on a control-plane node would still evict the pod mid-import. Tolerations are applied to
          // the unpinned fallback too — a tainted single-node cluster must still schedule the Job.
          ...(spec.nodeName ? { nodeName: spec.nodeName } : {}),
          tolerations: [
            { key: "node-role.kubernetes.io/control-plane", operator: "Exists" },
            { key: "node-role.kubernetes.io/master", operator: "Exists" },
          ],
          volumes: [
            { name: "containerd-sock", hostPath: { path: socket, type: "Socket" } },
            // The node's own k3s binary supplies `ctr` — exact version match, no 250 MB image pull.
            { name: "k3s-bin", hostPath: { path: k3sBin, type: "File" } },
            { name: "work", emptyDir: {} },
          ],
          containers: [
            {
              name: "import",
              image: spec.fetchImage ?? DEFAULT_FETCH_IMAGE,
              // URL via env (TAR_URL), referenced as $TAR_URL inside the shell — never in argv.
              env: [{ name: "TAR_URL", value: spec.tarUrl }],
              command: ["sh", "-c"],
              args: [
                `set -eu; curl -fsSL --retry 3 -o ${tarPath} "$TAR_URL"; ` +
                  `/host/k3s ctr --address ${socket} --namespace k8s.io images import ${tarPath}`,
              ],
              // root + privileged: the containerd socket is root-owned and needs host access.
              securityContext: { privileged: true, runAsUser: 0 },
              volumeMounts: [
                { name: "containerd-sock", mountPath: socket },
                { name: "k3s-bin", mountPath: "/host/k3s", readOnly: true },
                { name: "work", mountPath: "/work" },
              ],
              resources: { limits: { cpu: "1", memory: "512Mi", "ephemeral-storage": "8Gi" } },
            },
          ],
        },
      },
    },
  };
}
