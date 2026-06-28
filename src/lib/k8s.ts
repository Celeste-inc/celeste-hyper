import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { K8sLike } from "./k8s-port.ts";
import { buildExecArgs } from "../services/exec.ts";
import { aggregateNamespaces, type NamespaceCounts } from "../services/namespace-counts.ts";
import type { Hpa } from "../services/hpa.ts";
import { log } from "./logger.ts";

export type Runtime = "k3s" | "docker" | "containerd" | "auto";

export interface K8sConfig {
  kubeconfig?: string;
  runtime: Runtime;
  namespace: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function which(bin: string): boolean {
  // `bin` as an argv parameter ($1), never interpolated into the script — no shell injection.
  const r = Bun.spawnSync(["sh", "-c", 'command -v "$1" >/dev/null 2>&1', "--", bin]);
  return r.exitCode === 0;
}

function detectRuntime(): Exclude<Runtime, "auto"> {
  if (which("k3s")) return "k3s";
  if (which("docker")) return "docker";
  if (which("ctr")) return "containerd";
  throw new Error("no container runtime found (k3s | docker | containerd)");
}

function detectKubeconfig(): string | undefined {
  const candidates = [
    Bun.env.KUBECONFIG,
    "/etc/rancher/k3s/k3s.yaml",
    `${Bun.env.HOME ?? ""}/.kube/config`,
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) if (existsSync(p)) return p;
  return undefined;
}

export function imageImportCommand(runtime: Exclude<Runtime, "auto">, tarPath: string, uid = process.getuid?.(), sudoAvailable = which("sudo"), k3sAvailable = which("k3s")): string[] {
  const sudo = uid === 0 || !sudoAvailable ? [] : ["sudo"];
  if (runtime === "k3s") return [...sudo, "k3s", "ctr", "images", "import", tarPath];
  if (runtime === "containerd" && k3sAvailable) return [...sudo, "k3s", "ctr", "images", "import", tarPath];
  if (runtime === "containerd") return [...sudo, "ctr", "-n=k8s.io", "images", "import", tarPath];
  return ["docker", "load", "-i", tarPath];
}

export class K8s implements K8sLike {
  readonly runtime: Exclude<Runtime, "auto">;
  readonly kubeconfig: string | undefined;
  readonly defaultNamespace: string;

  constructor(cfg: K8sConfig) {
    this.runtime = cfg.runtime === "auto" ? detectRuntime() : cfg.runtime;
    this.kubeconfig = cfg.kubeconfig ?? detectKubeconfig();
    this.defaultNamespace = cfg.namespace;
    log.info("k8s.ready", { runtime: this.runtime, kubeconfig: this.kubeconfig });
  }

  private async run(cmd: string[], stdin?: string): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (this.kubeconfig) env.KUBECONFIG = this.kubeconfig;
      const child = spawn(cmd[0]!, cmd.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b.toString()));
      child.stderr.on("data", (b) => (stderr += b.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (stdin !== undefined) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    });
  }

  kubectl(args: string[], stdin?: string): Promise<RunResult> {
    const bin = this.runtime === "k3s" && !which("kubectl") ? ["k3s", "kubectl"] : ["kubectl"];
    return this.run([...bin, ...args], stdin);
  }

  async importImage(tarPath: string): Promise<RunResult> {
    return this.run(imageImportCommand(this.runtime, tarPath));
  }

  async applyManifest(yaml: string, namespace?: string): Promise<RunResult> {
    const ns = namespace ?? this.defaultNamespace;
    return this.kubectl(["-n", ns, "apply", "-f", "-"], yaml);
  }

  async applyFile(file: string, namespace?: string): Promise<RunResult> {
    const ns = namespace ?? this.defaultNamespace;
    return this.kubectl(["-n", ns, "apply", "-f", file]);
  }

  async upsertSecretFromEnvFile(name: string, file: string, namespace: string): Promise<RunResult> {
    const r = await this.kubectl([
      "-n", namespace,
      "create", "secret", "generic", name,
      `--from-env-file=${file}`,
      "--dry-run=client",
      "-o", "yaml",
    ]);
    if (r.code !== 0) return r;
    return this.kubectl(["-n", namespace, "apply", "-f", "-"], r.stdout);
  }

  async upsertConfigMapFromEnvFile(name: string, file: string, namespace: string): Promise<RunResult> {
    const r = await this.kubectl([
      "-n", namespace,
      "create", "configmap", name,
      `--from-env-file=${file}`,
      "--dry-run=client",
      "-o", "yaml",
    ]);
    if (r.code !== 0) return r;
    return this.kubectl(["-n", namespace, "apply", "-f", "-"], r.stdout);
  }

  async rolloutStatus(kind: string, name: string, namespace: string, timeoutSec: number): Promise<RunResult> {
    return this.kubectl([
      "-n", namespace, "rollout", "status", `${kind}/${name}`, `--timeout=${timeoutSec}s`,
    ]);
  }

  async setImage(
    kind: string,
    workloadName: string,
    containerName: string,
    image: string,
    namespace: string,
  ): Promise<RunResult> {
    return this.kubectl([
      "-n", namespace,
      "set", "image", `${kind.toLowerCase()}/${workloadName}`,
      `${containerName}=${image}`,
    ]);
  }

  // ── deploy-mode primitives (P1.7) ──────────────────────────────────
  async patchWorkloadStrategy(kind: string, name: string, namespace: string, strategyType: string): Promise<RunResult> {
    return this.kubectl([
      "-n", namespace, "patch", kind.toLowerCase(), "--type=merge",
      "-p", JSON.stringify({ spec: { strategy: { type: strategyType } } }), "--", name,
    ]);
  }

  /** Full workload JSON (for cloning into a canary / green deployment). */
  async getWorkloadJson(kind: string, name: string, namespace: string): Promise<RunResult> {
    return this.kubectl(["-n", namespace, "get", kind.toLowerCase(), "-o", "json", "--", name]);
  }

  async deleteWorkload(kind: string, name: string, namespace: string): Promise<RunResult> {
    return this.kubectl(["-n", namespace, "delete", kind.toLowerCase(), "--ignore-not-found", "--", name]);
  }

  async scaleWorkload(kind: string, name: string, namespace: string, replicas: number): Promise<RunResult> {
    return this.kubectl(["-n", namespace, "scale", `--replicas=${replicas}`, kind.toLowerCase(), "--", name]);
  }

  async patchServiceSelector(name: string, namespace: string, selector: Record<string, string>): Promise<RunResult> {
    // JSON-patch *replace* (not merge) so the selector becomes exactly `selector` — a clean
    // blue-green flip, not the union of old + new keys.
    return this.kubectl([
      "-n", namespace, "patch", "service", "--type=json",
      "-p", JSON.stringify([{ op: "replace", path: "/spec/selector", value: selector }]), "--", name,
    ]);
  }

  /** Ready replica count for a workload (0 if unreadable). */
  async getReadyReplicas(kind: string, name: string, namespace: string): Promise<number> {
    const r = await this.kubectl(["-n", namespace, "get", kind.toLowerCase(), "-o", "json", "--", name]);
    if (r.code !== 0) return 0;
    try {
      return (JSON.parse(r.stdout) as { status?: { readyReplicas?: number } }).status?.readyReplicas ?? 0;
    } catch {
      return 0;
    }
  }

  async namespaceCounts(): Promise<NamespaceCounts> {
    const [nsR, podR, wlR] = await Promise.all([
      this.kubectl(["get", "namespaces", "-o", "json"]),
      this.kubectl(["get", "pods", "-A", "-o", 'jsonpath={range .items[*]}{.metadata.namespace}{"\\n"}{end}']),
      this.kubectl([
        "get",
        "deployments,statefulsets,daemonsets",
        "-A",
        "-o",
        'jsonpath={range .items[*]}{.kind}{"="}{.metadata.namespace}{"\\n"}{end}',
      ]),
    ]);
    if (nsR.code !== 0) throw new Error(nsR.stderr || nsR.stdout);
    let nsParsed: { items?: RawNamespace[] };
    try {
      nsParsed = JSON.parse(nsR.stdout) as { items?: RawNamespace[] };
    } catch (e) {
      throw new Error(`kubectl returned non-JSON: ${(e as Error).message}`);
    }
    const namespaces = (nsParsed.items ?? []).map((it) => ({
      name: it.metadata?.name ?? "",
      phase: it.status?.phase ?? "",
      createdAt: it.metadata?.creationTimestamp ?? "",
    }));
    const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
    const podNamespaces = podR.code === 0 ? lines(podR.stdout) : [];
    const workloads =
      wlR.code === 0
        ? lines(wlR.stdout)
            .map((line) => {
              const eq = line.indexOf("="); // guard: empty kind (kubectl regression) → drop, don't silently zero
              if (eq <= 0) return null;
              return { kind: line.slice(0, eq), namespace: line.slice(eq + 1) };
            })
            .filter((w): w is { kind: string; namespace: string } => w !== null)
        : [];
    return { items: aggregateNamespaces(namespaces, podNamespaces, workloads), truncated: false };
  }

  async listHpas(namespace: string): Promise<Hpa[]> {
    const r = await this.kubectl(["-n", namespace, "get", "hpa", "-o", "json"]);
    if (r.code !== 0) return [];
    try {
      return (JSON.parse(r.stdout) as { items?: Hpa[] }).items ?? [];
    } catch {
      return [];
    }
  }

  async patchHpa(name: string, namespace: string, mergePatch: string): Promise<RunResult> {
    return this.kubectl(["-n", namespace, "patch", "hpa", "--type=merge", "-p", mergePatch, "--", name]);
  }

  async getIngressYaml(name: string, namespace: string): Promise<RunResult> {
    // `--` terminates flag parsing so a `-`-leading name can't be read as a kubectl flag
    // (defense-in-depth; the route also validates the name). Flags stay before the separator.
    return this.kubectl(["-n", namespace, "get", "ingress", "-o", "yaml", "--", name]);
  }

  async getWorkloadSelector(kind: string, name: string, namespace: string): Promise<string | null> {
    const r = await this.kubectl(["-n", namespace, "get", kind.toLowerCase(), name, "-o", "json"]);
    if (r.code !== 0) return null;
    try {
      const parsed = JSON.parse(r.stdout) as { spec?: { selector?: { matchLabels?: Record<string, string> } } };
      const ml = parsed.spec?.selector?.matchLabels;
      if (!ml || Object.keys(ml).length === 0) return null;
      return Object.entries(ml).map(([k, v]) => `${k}=${v}`).join(",");
    } catch {
      return null;
    }
  }

  async listEvents(namespace: string, fieldSelector?: string): Promise<K8sEvent[]> {
    const args = ["-n", namespace, "get", "events", "-o", "json"];
    if (fieldSelector) args.push(`--field-selector=${fieldSelector}`);
    const r = await this.kubectl(args);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    let parsed: { items?: RawEvent[] };
    try {
      parsed = JSON.parse(r.stdout) as { items?: RawEvent[] };
    } catch (e) {
      throw new Error(`kubectl returned non-JSON: ${(e as Error).message}`);
    }
    return (parsed.items ?? [])
      .map((e) => extractEvent(e))
      .filter((e): e is K8sEvent => e !== null);
  }

  async listPods(namespace: string, labelSelector?: string): Promise<ClusterPod[]> {
    const args = ["-n", namespace, "get", "pods", "-o", "json"];
    if (labelSelector) args.push("-l", labelSelector);
    const r = await this.kubectl(args);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    let parsed: { items?: RawPod[] };
    try {
      parsed = JSON.parse(r.stdout) as { items?: RawPod[] };
    } catch (e) {
      throw new Error(`kubectl returned non-JSON: ${(e as Error).message}`);
    }
    return (parsed.items ?? [])
      .map((p) => extractPod(p))
      .filter((p): p is ClusterPod => p !== null);
  }

  async getServiceInfo(name: string, namespace: string): Promise<K8sServiceInfo | null> {
    const r = await this.kubectl(["-n", namespace, "get", "svc", name, "-o", "json"]);
    if (r.code !== 0) return null;
    try {
      const parsed = JSON.parse(r.stdout) as RawService;
      return {
        name: parsed.metadata?.name ?? name,
        namespace: parsed.metadata?.namespace ?? namespace,
        type: parsed.spec?.type ?? "ClusterIP",
        clusterIP: parsed.spec?.clusterIP ?? null,
        clusterIPs: parsed.spec?.clusterIPs ?? (parsed.spec?.clusterIP ? [parsed.spec.clusterIP] : []),
        externalIPs: parsed.spec?.externalIPs ?? [],
        ports: (parsed.spec?.ports ?? []).map((p) => ({
          name: p.name ?? null,
          port: p.port,
          targetPort: p.targetPort ?? null,
          nodePort: p.nodePort ?? null,
          protocol: p.protocol ?? "TCP",
        })),
      };
    } catch {
      return null;
    }
  }

  async listNodes(): Promise<ClusterNode[]> {
    const r = await this.kubectl(["get", "nodes", "-o", "json"]);
    if (r.code !== 0) return [];
    try {
      const parsed = JSON.parse(r.stdout) as { items?: RawNode[] };
      return (parsed.items ?? []).map((n) => extractNode(n)).filter((n): n is ClusterNode => n !== null);
    } catch {
      return [];
    }
  }

  async listIngressesFor(svcName: string, namespace: string): Promise<IngressRule[]> {
    const r = await this.kubectl(["-n", namespace, "get", "ingress", "-o", "json"]);
    if (r.code !== 0) return [];
    try {
      const parsed = JSON.parse(r.stdout) as { items?: RawIngress[] };
      const out: IngressRule[] = [];
      for (const ing of parsed.items ?? []) {
        const tlsHosts = new Set<string>();
        for (const tls of ing.spec?.tls ?? []) for (const h of tls.hosts ?? []) tlsHosts.add(h);
        for (const rule of ing.spec?.rules ?? []) {
          const host = rule.host ?? "";
          const paths = rule.http?.paths ?? [];
          for (const p of paths) {
            const backend = p.backend?.service;
            if (backend?.name !== svcName) continue;
            out.push({
              host,
              path: p.path ?? "/",
              tls: tlsHosts.has(host),
              ingressName: ing.metadata?.name ?? "",
            });
          }
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  streamLogs(
    pod: string,
    container: string,
    namespace: string,
    tail: number,
  ): import("bun").Subprocess<"ignore", "pipe", "pipe"> {
    const bin = this.runtime === "k3s" ? ["k3s", "kubectl"] : ["kubectl"];
    const env = { ...process.env };
    if (this.kubeconfig) env.KUBECONFIG = this.kubeconfig;
    return Bun.spawn({
      cmd: [...bin, "-n", namespace, "logs", "-f", `--tail=${tail}`, pod, "-c", container],
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /** Spawn an interactive `kubectl exec -i` (P3.2). stdin is piped so the WS can feed keystrokes. */
  streamExec(pod: string, container: string, namespace: string): import("bun").Subprocess<"pipe", "pipe", "pipe"> {
    const bin = this.runtime === "k3s" ? ["k3s", "kubectl"] : ["kubectl"];
    const env = { ...process.env };
    if (this.kubeconfig) env.KUBECONFIG = this.kubeconfig;
    return Bun.spawn({
      cmd: [...bin, ...buildExecArgs(namespace, pod, container)],
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  async listAllDeployments(): Promise<ClusterWorkload[]> {
    const r = await this.kubectl(["get", "deployments,statefulsets,daemonsets", "-A", "-o", "json"]);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    let parsed: { items?: RawWorkload[] };
    try {
      parsed = JSON.parse(r.stdout) as { items?: RawWorkload[] };
    } catch (e) {
      throw new Error(`kubectl returned non-JSON: ${(e as Error).message}`);
    }
    const items = parsed.items ?? [];
    return items
      .map((it) => extractWorkload(it))
      .filter((w): w is ClusterWorkload => w !== null);
  }
}

interface RawNamespace {
  metadata?: { name?: string; creationTimestamp?: string };
  status?: { phase?: string };
}

interface RawWorkload {
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: {
    replicas?: number;
    template?: { spec?: { containers?: { name?: string; image?: string }[] } };
  };
  status?: { readyReplicas?: number; replicas?: number };
}

export interface ClusterWorkload {
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas: number;
  containers: { name: string; image: string }[];
  labels: Record<string, string>;
}

const SUPPORTED_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

interface RawPod {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { nodeName?: string; containers?: { name?: string; image?: string }[] };
  status?: {
    phase?: string;
    podIP?: string;
    podIPs?: { ip: string }[];
    hostIP?: string;
    startTime?: string;
    containerStatuses?: {
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
    }[];
  };
}

interface RawService {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    type?: string;
    clusterIP?: string;
    clusterIPs?: string[];
    externalIPs?: string[];
    ports?: {
      name?: string;
      port: number;
      targetPort?: string | number;
      nodePort?: number;
      protocol?: string;
    }[];
  };
}

export interface ClusterPod {
  name: string;
  namespace: string;
  phase: string;
  podIP: string | null;
  podIPs: string[];
  hostIP: string | null;
  nodeName: string | null;
  startTime: string | null;
  containers: { name: string; image: string; ready: boolean; restartCount: number; waitingReason?: string; terminatedReason?: string }[];
}

export interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  involvedObject: { kind: string; name: string };
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  count: number;
}

interface RawEvent {
  type?: string;
  reason?: string;
  message?: string;
  involvedObject?: { kind?: string; name?: string };
  firstTimestamp?: string | null;
  lastTimestamp?: string | null;
  eventTime?: string | null;
  count?: number;
}

function extractEvent(raw: RawEvent): K8sEvent | null {
  const kind = raw.involvedObject?.kind;
  const name = raw.involvedObject?.name;
  if (!kind || !name) return null;
  return {
    type: raw.type ?? "Normal",
    reason: raw.reason ?? "",
    message: raw.message ?? "",
    involvedObject: { kind, name },
    firstTimestamp: raw.firstTimestamp ?? raw.eventTime ?? null,
    lastTimestamp: raw.lastTimestamp ?? raw.eventTime ?? null,
    count: raw.count ?? 1,
  };
}

export interface K8sServicePort {
  name: string | null;
  port: number;
  targetPort: string | number | null;
  nodePort: number | null;
  protocol: string;
}

export interface K8sServiceInfo {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string | null;
  clusterIPs: string[];
  externalIPs: string[];
  ports: K8sServicePort[];
}

interface RawNode {
  metadata?: { name?: string };
  status?: { addresses?: { type?: string; address?: string }[] };
}

interface RawIngress {
  metadata?: { name?: string };
  spec?: {
    tls?: { hosts?: string[] }[];
    rules?: {
      host?: string;
      http?: {
        paths?: { path?: string; backend?: { service?: { name?: string; port?: { number?: number; name?: string } } } }[];
      };
    }[];
  };
}

export interface ClusterNode {
  name: string;
  internalIP: string | null;
  externalIP: string | null;
  hostname: string | null;
}

export interface IngressRule {
  host: string;
  path: string;
  tls: boolean;
  ingressName: string;
}

function extractNode(raw: RawNode): ClusterNode | null {
  if (!raw.metadata?.name) return null;
  const addrs = raw.status?.addresses ?? [];
  const pick = (type: string) => addrs.find((a) => a.type === type)?.address ?? null;
  return {
    name: raw.metadata.name,
    internalIP: pick("InternalIP"),
    externalIP: pick("ExternalIP"),
    hostname: pick("Hostname"),
  };
}

function extractPod(raw: RawPod): ClusterPod | null {
  const name = raw.metadata?.name;
  const namespace = raw.metadata?.namespace;
  if (!name || !namespace) return null;
  const containerSpecs = raw.spec?.containers ?? [];
  const containerStatuses = raw.status?.containerStatuses ?? [];
  const containers = containerSpecs.map((cs) => {
    const st = containerStatuses.find((s) => s.name === cs.name);
    return {
      name: cs.name ?? "?",
      image: cs.image ?? "?",
      ready: st?.ready ?? false,
      restartCount: st?.restartCount ?? 0,
      waitingReason: st?.state?.waiting?.reason,
      // Only the CURRENT terminated state — not lastState — so a pod that OOMKilled once and
      // recovered isn't falsely failed by the health gate (repeated OOM is caught via restartCount).
      terminatedReason: st?.state?.terminated?.reason,
    };
  });
  return {
    name,
    namespace,
    phase: raw.status?.phase ?? "Unknown",
    podIP: raw.status?.podIP ?? null,
    podIPs: (raw.status?.podIPs ?? []).map((p) => p.ip),
    hostIP: raw.status?.hostIP ?? null,
    nodeName: raw.spec?.nodeName ?? null,
    startTime: raw.status?.startTime ?? null,
    containers,
  };
}

function extractWorkload(raw: RawWorkload): ClusterWorkload | null {
  if (!raw.kind || !SUPPORTED_KINDS.has(raw.kind)) return null;
  const name = raw.metadata?.name;
  const namespace = raw.metadata?.namespace;
  if (!name || !namespace) return null;
  const containers = (raw.spec?.template?.spec?.containers ?? [])
    .filter((c) => Boolean(c.name && c.image))
    .map((c) => ({ name: c.name!, image: c.image! }));
  if (containers.length === 0) return null;
  return {
    kind: raw.kind as ClusterWorkload["kind"],
    name,
    namespace,
    replicas: raw.spec?.replicas ?? raw.status?.replicas ?? 0,
    readyReplicas: raw.status?.readyReplicas ?? 0,
    containers,
    labels: raw.metadata?.labels ?? {},
  };
}
