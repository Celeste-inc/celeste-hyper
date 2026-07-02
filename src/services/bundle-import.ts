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
}

/** Deterministic, RFC-1123-safe (≤63 char) Job name for a service+tag import. */
/** Lowercase to `[a-z0-9-]`, collapsing runs and trimming dashes — safe for a k8s name/label segment. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function importJobName(service: string, tag: string): string {
  const base = `celeste-import-${slug(service)}-${slug(tag)}`.slice(0, 62);
  return base.replace(/-+$/g, "") || "celeste-import";
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

/** Apply the import Job to the (remote) cluster, poll it to completion, and always tear it down.
 *  Pure orchestration over the injected K8s + delay — unit-tested with fakes. Every apiserver call is
 *  timeout-bounded (`REQ_TIMEOUT`) so a partitioned remote node can't hang the deploy worker. */
export async function runRemoteBundleImport(args: RemoteImportArgs): Promise<{ ok: boolean; message: string }> {
  const { k8s, presignedUrl, service, namespace, tag, delay } = args;
  const name = importJobName(service, tag);
  const deadlineSec = args.deadlineSec ?? DEFAULT_DEADLINE_SEC;
  const job = buildBundleImportJob({ service, namespace, tag, tarUrl: presignedUrl, socketPath: args.socketPath, deadlineSec });
  // A Job's pod template is immutable, so a leftover Job from a crashed/retried attempt would make
  // `apply` fail. Delete any prior instance first (idempotent) so retries are clean.
  await deleteJob(k8s, name, namespace);
  const applied = await k8s.kubectl(["-n", namespace, "apply", "-f", "-", REQ_TIMEOUT], JSON.stringify(job));
  if (applied.code !== 0) {
    // The create may have raced (accepted server-side, error on the client read), so tear down before
    // returning — never leave an unmonitored privileged Job behind.
    await deleteJob(k8s, name, namespace);
    return { ok: false, message: `apply import job: ${(applied.stderr || applied.stdout).trim().slice(0, 200)}` };
  }
  try {
    const tickMs = args.tickMs ?? DEFAULT_POLL_TICK_MS;
    // Poll PAST the Job's own activeDeadlineSeconds (+60s margin) so a slow-but-valid import is
    // observed as the Job's DeadlineExceeded (status.failed), never abandoned + torn down early.
    const ticks = args.pollTicks ?? Math.ceil(((deadlineSec + 60) * 1000) / tickMs);
    for (let i = 0; i < ticks; i++) {
      const r = await k8s.kubectl(["-n", namespace, "get", "job", "-o", "json", REQ_TIMEOUT, "--", name]);
      if (r.code === 0) {
        let status: { succeeded?: number; failed?: number } = {};
        try {
          status = (JSON.parse(r.stdout) as { status?: typeof status }).status ?? {};
        } catch {
          // a transient non-JSON read — keep polling
        }
        if ((status.succeeded ?? 0) >= 1) return { ok: true, message: `imported on the node via Job/${name}` };
        if ((status.failed ?? 0) >= 1) {
          // Capture the pod's logs BEFORE the finally block tears the Job down (else the operator sees
          // only "failed" with no cause).
          const tail = await captureJobLogs(k8s, name, namespace);
          return { ok: false, message: `import Job/${name} failed on the node${tail ? `: ${tail}` : ""}` };
        }
      }
      await delay(tickMs);
    }
    return { ok: false, message: `import Job/${name} did not complete in time` };
  } finally {
    await deleteJob(k8s, name, namespace);
  }
}

/** Build the one-shot privileged image-import Job manifest (a plain object; the deployer JSON-encodes
 *  it for `kubectl apply -f -`). All hardening (no retries, deadline, self-delete, no SA token, URL via
 *  env) is baked in here so it is reviewed + tested in one pure place. */
export function buildBundleImportJob(spec: BundleImportSpec): object {
  const socket = spec.socketPath ?? K3S_CONTAINERD_SOCKET;
  const k3sBin = spec.k3sBinaryPath ?? K3S_HOST_BINARY;
  const name = importJobName(spec.service, spec.tag);
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
