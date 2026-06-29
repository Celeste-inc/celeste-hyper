import { Elysia, sse } from "elysia";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { ApiDeps } from "./deps.ts";
import { authenticate } from "./auth.ts";
import { withinScope } from "./scope.ts";
import { ExecSession, isValidK8sName, type ExecSocket, type ExecProc } from "../services/exec.ts";
import { log } from "../lib/logger.ts";
import { type Clock, realClock } from "../lib/clock.ts";
import {
  workloadNameFor,
  containerNameFor,
  relatedWorkloadsFor,
  workloadKindFor,
  type ServiceModel,
} from "../services/model.ts";
import { findHpaForWorkload, summarizeHpa, validateHpaPatch, buildHpaPatch } from "../services/hpa.ts";
import { parseTopPods, summarizePodMetrics } from "../services/metrics.ts";
import { computeServiceSlo, type DegradedRange } from "../services/slo.ts";
import {
  buildServicePortPatch,
  buildDeploymentContainerPortPatch,
} from "../services/networking-patch.ts";
import type { ClusterNode, IngressRule, K8sServiceInfo } from "../lib/k8s.ts";
import type { DnsHint } from "../lib/dns-hint.ts";

const HpaPatchBody = z
  .object({
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    targetCPUUtilizationPercentage: z.number().int().optional(),
  })
  .strict();

// Permissive IP/hostname check (k8s lets externalIPs be DNS names too). The full RFC validation
// happens server-side anyway; this just rejects obvious garbage and bounds the length.
const EXTERNAL_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:\-]{0,252}$/;

const NetworkingPatchBody = z
  .object({
    portName: z.string().min(1).max(63).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    targetPort: z.union([z.number().int().min(1).max(65535), z.string().min(1).max(63)]).optional(),
    nodePort: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(["TCP", "UDP"]).optional(),
    type: z.enum(["ClusterIP", "NodePort", "LoadBalancer"]).optional(),
    externalIPs: z.array(z.string().regex(EXTERNAL_HOST_RE)).max(8).optional(),
  })
  .strict();

interface ServiceEndpoint {
  kind: "cluster-ip" | "node-port" | "ingress" | "load-balancer";
  url: string;
  description: string;
  copyable: boolean;
  reachableFromHost: boolean;
  /** Set on ingress entries so the UI can offer "view source" for the backing Ingress object. */
  source?: { kind: "ingress"; ingressName: string; ingressNamespace: string };
  /** DNS reachability hint (ingress entries only), filled in by the networking handler. */
  dns?: DnsHint;
}

export function computeEndpoints(
  service: K8sServiceInfo,
  nodes: ClusterNode[],
  ingresses: IngressRule[],
  accessHost: string | undefined,
  namespace: string,
): ServiceEndpoint[] {
  const endpoints: ServiceEndpoint[] = [];
  const httpPorts = service.ports.filter((p) => p.protocol === "TCP" || p.protocol === undefined);
  for (const port of httpPorts) {
    if (service.clusterIP) {
      endpoints.push({
        kind: "cluster-ip",
        url: `http://${service.clusterIP}:${port.port}`,
        description: `In-cluster via ClusterIP${port.name ? ` (${port.name})` : ""}`,
        copyable: true,
        reachableFromHost: false,
      });
    }
    if (port.nodePort) {
      const candidates = new Set<string>();
      if (accessHost) candidates.add(accessHost);
      for (const node of nodes) {
        if (node.externalIP) candidates.add(node.externalIP);
        if (node.internalIP) candidates.add(node.internalIP);
      }
      candidates.add("localhost");
      for (const host of candidates) {
        endpoints.push({
          kind: "node-port",
          url: `http://${host}:${port.nodePort}`,
          description: `NodePort via ${host}${port.name ? ` (${port.name})` : ""}`,
          copyable: true,
          reachableFromHost: host === "localhost" || host === accessHost,
        });
      }
    }
  }
  for (const ip of service.externalIPs ?? []) {
    for (const port of httpPorts) {
      endpoints.push({
        kind: "load-balancer",
        url: `http://${ip}:${port.port}`,
        description: "External IP",
        copyable: true,
        reachableFromHost: true,
      });
    }
  }
  for (const ing of ingresses) {
    const scheme = ing.tls ? "https" : "http";
    endpoints.push({
      kind: "ingress",
      url: `${scheme}://${ing.host}${ing.path === "/" ? "" : ing.path}`,
      description: `Ingress ${ing.ingressName}`,
      copyable: true,
      reachableFromHost: true,
      source: { kind: "ingress", ingressName: ing.ingressName, ingressNamespace: namespace },
    });
  }
  return endpoints;
}

interface LogProc {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: () => void;
}

/**
 * Merge stdout/stderr line-by-line into SSE frames, then emit `end` with the exit code.
 * `signal` (the request's AbortSignal) kills the subprocess immediately on client disconnect
 * and wakes the parked loop so the generator terminates and runs its `finally` cleanup —
 * without it, an idle `kubectl logs -f` would park at the inner `await` and never be killed.
 */
const HEARTBEAT_MS = 15_000;

export async function* logEvents(proc: LogProc, signal?: AbortSignal, clock: Clock = realClock()) {
  const queue: Array<{ event: "stdout" | "stderr" | "error" | "heartbeat"; data: string }> = [];
  let notify: (() => void) | null = null;
  let active = 2;
  let aborted = false;
  const wake = () => {
    notify?.();
    notify = null;
  };
  // Keep-alive: emit a heartbeat frame every 15s so buffering proxies don't drop the stream.
  let heartbeat = clock.setTimeout(function tick() {
    queue.push({ event: "heartbeat", data: "" });
    wake();
    heartbeat = clock.setTimeout(tick, HEARTBEAT_MS);
  }, HEARTBEAT_MS);
  const onAbort = () => {
    aborted = true;
    try {
      proc.kill();
    } catch {
      // already gone
    }
    active = 0;
    wake();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const drain = async (readable: ReadableStream<Uint8Array> | null, level: "stdout" | "stderr") => {
    if (!readable) {
      active--;
      wake();
      return;
    }
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          queue.push({ event: level, data: line });
          wake();
        }
      }
      if (buf) {
        queue.push({ event: level, data: buf });
        wake();
      }
    } catch (e) {
      queue.push({ event: "error", data: (e as Error).message });
      wake();
    } finally {
      active--;
      wake();
    }
  };

  void drain(proc.stdout, "stdout");
  void drain(proc.stderr, "stderr");
  let exitCode = 0;
  const exited = proc.exited.then((c) => {
    exitCode = c ?? 0;
  }).catch(() => {
    exitCode = 0;
  });

  try {
    while (true) {
      while (queue.length) {
        const ev = queue.shift()!;
        yield sse({ event: ev.event, data: ev.data });
      }
      if (aborted) return; // client disconnected — stop without an end frame
      if (active <= 0) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    await exited;
    yield sse({ event: "end", data: String(exitCode) });
  } finally {
    clock.clearTimeout(heartbeat);
    if (signal) signal.removeEventListener("abort", onAbort);
    try {
      proc.kill();
    } catch {
      // process already gone
    }
  }
}

// Re-probe a cluster's capabilities when the cached answer is negative or older than this. Stops
// the metrics/HPA panel from being permanently dark when metrics-server/api-services come online
// after Hyper's first poll (cluster boot order race).
const STALE_NEGATIVE_MS = 30_000;

async function capabilityValue(
  deps: ApiDeps,
  clusterId: string,
  key: "hpaV2" | "metricsServerV1Beta1",
): Promise<boolean> {
  let merged = deps.capabilities.merged(clusterId);
  const cached = merged.capabilities[key]?.value === true;
  const lastCheckedAt = merged.lastCheckedAt ? Date.parse(merged.lastCheckedAt) : null;
  const stale = lastCheckedAt === null || (!cached && deps.clock.now() - lastCheckedAt > STALE_NEGATIVE_MS);
  if (stale) {
    await deps.capabilities.refreshCluster(clusterId);
    merged = deps.capabilities.merged(clusterId);
  }
  return merged.capabilities[key]?.value === true;
}

async function hpaCapable(deps: ApiDeps, clusterId: string): Promise<boolean> {
  return capabilityValue(deps, clusterId, "hpaV2");
}

async function metricsCapable(deps: ApiDeps, clusterId: string): Promise<boolean> {
  return capabilityValue(deps, clusterId, "metricsServerV1Beta1");
}

export const serviceOpsRoutes = (deps: ApiDeps) => {
  interface WorkloadTarget {
    role: "primary" | "related";
    workloadName: string;
    kind: string;
    /** Container override declared on the spec; logs default to this when ?container is omitted. */
    containerName: string | undefined;
    selector: string;
    namespace: string;
    clusterId: string;
  }

  /**
   * Resolve every workload tracked under this service: the primary plus any `relatedWorkloads`
   * declared in the spec. Each target gets its own pod selector (preferred via
   * `getWorkloadSelector`, fallback to `app=<workloadName>`) so a `kubectl set selector` on the
   * underlying Deployment is reflected without operator action.
   *
   * Caps the total list at 1 (primary) + 8 (`RelatedWorkloadSchema.max(8)`) to bound the per-call
   * fan-out.
   */
  const findWorkloadTargets = async (svc: ServiceModel): Promise<WorkloadTarget[]> => {
    const k8s = deps.pool.get(svc.clusterId);
    if (!k8s) return [];
    const primaryName = workloadNameFor(svc);
    const primaryKind = svc.sourceType === "registry-pull" ? svc.workloadKind : "Deployment";
    const targets: WorkloadTarget[] = [];
    const seen = new Set<string>();
    const push = async (role: "primary" | "related", name: string, kind: string, container?: string) => {
      const key = `${kind}:${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const sel = (await k8s.getWorkloadSelector(kind, name, svc.namespace)) ?? `app=${name}`;
      targets.push({
        role,
        workloadName: name,
        kind,
        containerName: container,
        selector: sel,
        namespace: svc.namespace,
        clusterId: svc.clusterId,
      });
    };
    await push("primary", primaryName, primaryKind, svc.containerName);
    for (const r of relatedWorkloadsFor(svc)) await push("related", r.name, r.kind, r.containerName);
    return targets;
  };

  /** Back-compat: return the primary target only, in the old `{selector, namespace, clusterId}` shape. */
  const findPodSelector = async (
    svcName: string,
  ): Promise<{ selector: string; namespace: string; clusterId: string } | null> => {
    const svc = deps.registry.get(svcName);
    if (!svc) return null;
    const targets = await findWorkloadTargets(svc);
    const primary = targets.find((t) => t.role === "primary");
    return primary ? { selector: primary.selector, namespace: primary.namespace, clusterId: primary.clusterId } : null;
  };

  /** Confirm `pod`/`container` actually back THIS service (any of its workloads). Namespaces are
   *  shared, so without this guard a caller could read another service's logs/exec via ?pod=. */
  const verifyPodContainer = async (
    svcName: string,
    pod: string,
    container: string,
  ): Promise<boolean> => {
    const svc = deps.registry.get(svcName);
    if (!svc) return false;
    const targets = await findWorkloadTargets(svc);
    if (targets.length === 0) return false;
    const k8s = deps.pool.get(svc.clusterId);
    if (!k8s) return false;
    for (const t of targets) {
      try {
        const pods = (await k8s.listPods(t.namespace, t.selector)) as Array<{
          name?: string;
          containers?: Array<{ name?: string }>;
        }>;
        const match = pods.find((p) => p.name === pod);
        if (match && match.containers?.some((c) => c.name === container)) return true;
      } catch {
        // try the next target rather than failing the whole verify on a single transient error
      }
    }
    return false;
  };

  // Live exec sessions, keyed by the WS connection (cleaned up on close). Capped to bound the number
  // of concurrent kubectl-exec subprocesses an operator can spawn (resource-exhaustion guard).
  const execSessions = new Map<object, ExecSession>();
  const MAX_EXEC_SESSIONS = 16;

  return new Elysia()
    .get(
      "/services/:name/pods",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const targets = await findWorkloadTargets(svc);
        if (targets.length === 0) return { items: [], groups: [] };
        try {
          const k8s = deps.pool.getOrThrow(svc.clusterId);
          // Fan-out: each workload's pod list is independent; serial would be N round-trips
          // when N can be ≤ 9 (primary + 8 related). Pool's kubectl is sync-spawn anyway.
          const groups = await Promise.all(
            targets.map(async (t) => {
              try {
                const pods = await k8s.listPods(t.namespace, t.selector);
                return { workload: t.workloadName, kind: t.kind, role: t.role, selector: t.selector, pods };
              } catch (e) {
                return { workload: t.workloadName, kind: t.kind, role: t.role, selector: t.selector, pods: [], error: (e as Error).message };
              }
            }),
          );
          // Back-compat flat list so existing UI keeps rendering until it adopts `groups`.
          const items = groups.flatMap((g) => g.pods);
          const primary = groups.find((g) => g.role === "primary");
          return { items, groups, selector: primary?.selector };
        } catch (e) {
          return { items: [], groups: [], error: (e as Error).message };
        }
      },
      { detail: { summary: "List pods backing a service (grouped by workload)", tags: ["service-ops"] } },
    )
    .get(
      "/services/:name/events",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const targets = await findWorkloadTargets(svc);
        if (targets.length === 0) return { items: [] };
        try {
          const k8s = deps.pool.getOrThrow(svc.clusterId);
          // Pods come from all targets; events from the (shared) namespace are filtered client-side.
          const podsPerTarget = await Promise.all(
            targets.map((t) => k8s.listPods(t.namespace, t.selector).catch(() => [] as Array<{ name?: string }>)),
          );
          const podNames = new Set(podsPerTarget.flat().map((p) => p.name));
          const events = await k8s.listEvents(svc.namespace);
          const items = events
            .filter((e) => e.involvedObject.kind === "Pod" && podNames.has(e.involvedObject.name))
            .sort((a, b) => (b.lastTimestamp ?? "").localeCompare(a.lastTimestamp ?? ""))
            .slice(0, 50);
          return { items };
        } catch (e) {
          return { items: [], error: (e as Error).message };
        }
      },
      { detail: { summary: "List Kubernetes events for pods backing a service (all workloads)", tags: ["service-ops"] } },
    )
    .get(
      "/services/:name/networking",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return { service: null, hint: `cluster '${svc.clusterId}' not configured` };
        const target = workloadNameFor(svc);
        const info = (await k8s.getServiceInfo(target, svc.namespace)) ?? (await k8s.getServiceInfo(svc.name, svc.namespace));
        if (!info) return { service: null, hint: "no Service object found in namespace" };
        const cluster = deps.clusters.get(svc.clusterId);
        const [nodes, ingresses] = await Promise.all([
          k8s.listNodes(),
          k8s.listIngressesFor(info.name, svc.namespace),
        ]);
        const endpoints = computeEndpoints(info, nodes, ingresses, cluster?.accessHost, svc.namespace);
        // Annotate ingress endpoints with a DNS reachability hint (timeout-bounded + cached).
        await Promise.all(
          endpoints
            .filter((e) => e.kind === "ingress" && e.source)
            .map(async (e) => {
              let host: string;
              try {
                host = new URL(e.url).hostname;
              } catch {
                return; // malformed ingress host (e.g. wildcard with no host) — skip, don't 500
              }
              if (!host) return; // empty host (parsed but blank) — nothing to resolve
              e.dns = await deps.dns(host);
            }),
        );
        return { service: { ...info, endpoints } };
      },
      { detail: { summary: "Networking and reachable endpoints for a service", tags: ["service-ops"] } },
    )
    .get(
      "/services/:name/logs",
      async ({ params, query, status, set, request }) => {
        // The log stream is carved out of the global guard, so it authenticates itself:
        // a one-shot ?logToken= (for EventSource), else a normal cookie/bearer session.
        const logToken = query.logToken;
        let authed: boolean;
        if (logToken) {
          authed = deps.state.redeemLogToken(logToken, params.name); // already service-bound
        } else {
          // Carve-out path skips the global guard, so enforce scope here too (P1.10): a scoped
          // machine token must not read another service's logs just because logs is a carve-out.
          const principal = await authenticate(request, deps);
          authed = principal !== null && withinScope(principal, `/api/services/${params.name}/logs`, deps);
        }
        if (!authed) return status(401, { error: "unauthorized" });

        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const pod = query.pod;
        if (!pod) return status(400, { error: "pod query parameter required" });
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });

        // Confine the stream to pods/containers backing THIS service (primary OR related).
        // Namespaces are shared, so without this a caller could read any pod's logs via ?pod=.
        let podMatch: { name?: string; containers?: Array<{ name?: string }> } | undefined;
        let matchedTarget: WorkloadTarget | undefined;
        try {
          const targets = await findWorkloadTargets(svc);
          for (const t of targets) {
            const pods = (await k8s.listPods(t.namespace, t.selector)) as Array<{
              name?: string;
              containers?: Array<{ name?: string }>;
            }>;
            const m = pods.find((p) => p.name === pod);
            if (m) {
              podMatch = m;
              matchedTarget = t;
              break;
            }
          }
        } catch {
          return status(502, { error: "unable to verify pod ownership" });
        }
        if (!podMatch || !matchedTarget) return status(404, { error: "pod not found for this service" });

        const containers = (podMatch.containers ?? []).map((c) => c.name).filter((n): n is string => !!n);
        // Default container: explicit (related) override > primary's containerName > primary's name.
        // If the related has no override and the pod has multiple containers, the operator must
        // pass ?container — we don't guess.
        const defaultContainer =
          matchedTarget.role === "primary"
            ? containerNameFor(svc)
            : (matchedTarget.containerName ?? (containers.length === 1 ? containers[0] : ""));
        const container = query.container || defaultContainer;
        if (!container) return status(400, { error: "container query parameter required for multi-container pod" });
        if (query.container && containers.length > 0 && !containers.includes(query.container)) {
          return status(404, { error: "container not found in pod" });
        }
        const tail = Math.max(1, Math.min(2000, Number(query.tail ?? 200)));
        set.headers["cache-control"] = "no-cache, no-transform";
        set.headers["x-accel-buffering"] = "no";
        return logEvents(k8s.streamLogs(pod, container, svc.namespace, tail) as unknown as LogProc, request.signal, deps.clock);
      },
      { detail: { summary: "Stream pod logs over SSE (one-shot ?logToken or cookie/bearer)", tags: ["service-ops"] } },
    )
    .post(
      "/services/:name/logs/token",
      ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const token = randomBytes(24).toString("hex");
        const expiresAt = deps.state.createLogToken(token, params.name, 60_000);
        return { token, expiresAt: new Date(expiresAt).toISOString() };
      },
      { detail: { summary: "Mint a one-shot 60s log-stream token (requires auth)", tags: ["service-ops"] } },
    )
    .post(
      "/services/:name/exec/token",
      async ({ params, body, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const b = (body ?? {}) as { pod?: unknown; container?: unknown };
        if (typeof b.pod !== "string" || typeof b.container !== "string" || !isValidK8sName(b.pod) || !isValidK8sName(b.container)) {
          return status(400, { error: "valid pod and container are required" });
        }
        // RCE-equivalent: only mint for a pod+container that actually backs this service.
        if (!(await verifyPodContainer(svc.name, b.pod, b.container))) {
          return status(403, { error: "pod/container does not belong to this service" });
        }
        const token = randomBytes(24).toString("hex");
        const expiresAt = deps.state.createExecToken(token, svc.name, b.pod, b.container, 60_000);
        return { token, expiresAt: new Date(expiresAt).toISOString() };
      },
      { detail: { summary: "Mint a one-shot 60s exec/terminal token (operator+, pod-ownership-checked)", tags: ["service-ops"] } },
    )
    .ws("/services/:name/exec", {
      // Auth carve-out: the one-shot ?token (operator-minted, bound to service+pod+container) is the
      // WS's only credential. RCE-equivalent, so the bound (pod, container) — not the URL — decide what runs.
      open(ws) {
        const { name } = ws.data.params as { name: string };
        const token = (ws.data.query as { token?: string }).token;
        if (!token) return ws.close();
        if (execSessions.size >= MAX_EXEC_SESSIONS) return ws.close(); // too many concurrent shells
        const redeemed = deps.state.redeemExecToken(token, name);
        if (!redeemed) return ws.close();
        const svc = deps.registry.get(name);
        const k8s = svc ? deps.pool.get(svc.clusterId) : null;
        if (!svc || !k8s?.streamExec) return ws.close();
        const proc = k8s.streamExec(redeemed.pod, redeemed.container, svc.namespace);
        const socket: ExecSocket = { send: (d) => ws.send(d), close: () => ws.close() };
        const execProc: ExecProc = {
          stdout: proc.stdout,
          stderr: proc.stderr,
          write: (d) => {
            proc.stdin.write(d);
            proc.stdin.flush();
          },
          kill: () => proc.kill(),
          exited: proc.exited,
        };
        execSessions.set(ws, new ExecSession(socket, execProc));
        // Forensic record that a shell was actually opened (the WS is an auth carve-out, so it
        // produces no HTTP audit row; the mint POST is separately audited with the actor).
        log.info("exec.session_opened", { service: name, pod: redeemed.pod, container: redeemed.container });
      },
      message(ws, message) {
        execSessions.get(ws)?.onMessage(typeof message === "string" ? message : (message as Uint8Array));
      },
      close(ws) {
        const { name } = ws.data.params as { name: string };
        if (execSessions.has(ws)) log.info("exec.session_closed", { service: name });
        execSessions.get(ws)?.onClose();
        execSessions.delete(ws);
      },
    })
    .get(
      "/services/:name/hpa",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        if (!(await hpaCapable(deps, svc.clusterId))) {
          return status(409, { error: "hpaV2 capability not available on this cluster" });
        }
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });
        const kind = svc.sourceType === "registry-pull" ? svc.workloadKind : "Deployment";
        const hpa = findHpaForWorkload(await k8s.listHpas(svc.namespace), kind, workloadNameFor(svc));
        return { hpa: hpa ? summarizeHpa(hpa) : null };
      },
      { detail: { summary: "HPA targeting this service's workload (capability-gated)", tags: ["service-ops"] } },
    )
    .patch(
      "/services/:name/hpa",
      async ({ params, body, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        if (!(await hpaCapable(deps, svc.clusterId))) {
          return status(409, { error: "hpaV2 capability not available on this cluster" });
        }
        const parsed = HpaPatchBody.safeParse(body ?? {});
        if (!parsed.success) {
          const unexpected = parsed.error.issues.some((i) => i.code === "unrecognized_keys");
          return status(422, { error: unexpected ? "unexpected_field" : "invalid body", issues: parsed.error.issues });
        }
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });
        const kind = svc.sourceType === "registry-pull" ? svc.workloadKind : "Deployment";
        const current = findHpaForWorkload(await k8s.listHpas(svc.namespace), kind, workloadNameFor(svc));
        if (!current) return status(404, { error: "no HPA targets this workload" });
        const invalid = validateHpaPatch(parsed.data, current);
        if (invalid) return status(422, { error: invalid });
        const hpaName = current.metadata?.name;
        if (!hpaName) return status(500, { error: "HPA has no metadata.name" });
        const r = await k8s.patchHpa(hpaName, svc.namespace, JSON.stringify(buildHpaPatch(current, parsed.data)));
        if (r.code !== 0) return status(502, { error: r.stderr || r.stdout });
        const updated = findHpaForWorkload(await k8s.listHpas(svc.namespace), kind, workloadNameFor(svc));
        return { hpa: updated ? summarizeHpa(updated) : null };
      },
      { detail: { summary: "Patch min/max/CPU target on the service's HPA (operator+)", tags: ["service-ops"] } },
    )
    .get(
      "/services/:name/metrics",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        if (!(await metricsCapable(deps, svc.clusterId))) {
          return status(409, { error: "metrics.k8s.io capability not available on this cluster" });
        }
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });
        const selectorTarget = await findPodSelector(svc.name);
        const selector = selectorTarget?.selector ?? `app=${workloadNameFor(svc)}`;
        const r = await k8s.kubectl([
          "-n", svc.namespace, "top", "pods", "-l", selector, "--no-headers",
        ]);
        if (r.code !== 0) return status(502, { error: (r.stderr || r.stdout).trim() || "kubectl top failed" });
        const pods = parseTopPods(r.stdout);
        return { pods, summary: summarizePodMetrics(pods) };
      },
      { detail: { summary: "Live CPU/RAM usage per pod (via metrics-server)", tags: ["service-ops"] } },
    )
    .get(
      "/services/:name/slo",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const deployments = deps.state.recentDeployments(svc.name, 100);
        const degraded = deps.state.serviceDegraded(svc.name);
        const degradedRanges: DegradedRange[] = degraded ? [{ startedAt: degraded.at, clearedAt: null }] : [];
        // Pod restart counts (best-effort: empty when the cluster is unreachable).
        const restartCounts: number[] = [];
        try {
          const k8s = deps.pool.get(svc.clusterId);
          if (k8s) {
            const target = await findPodSelector(svc.name);
            const selector = target?.selector ?? `app=${workloadNameFor(svc)}`;
            const pods = (await k8s.listPods(svc.namespace, selector)) as Array<{ containers?: Array<{ restartCount?: number }> }>;
            for (const p of pods) {
              const podTotal = (p.containers ?? []).reduce((s, c) => s + (c.restartCount ?? 0), 0);
              restartCounts.push(podTotal);
            }
          }
        } catch {
          // pod fetch optional — fall through with what we have
        }
        return computeServiceSlo({
          now: deps.clock.now(),
          deployments,
          restartCounts,
          degradedRanges,
        });
      },
      { detail: { summary: "Service-level objective digest (deploy success, MTTR, restarts, health)", tags: ["service-ops"] } },
    )
    .patch(
      "/services/:name/networking",
      async ({ params, body, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const parsed = NetworkingPatchBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const k8s = deps.pool.get(svc.clusterId);
        if (!k8s) return status(500, { error: `cluster '${svc.clusterId}' not configured` });
        const info = (await k8s.getServiceInfo(workloadNameFor(svc), svc.namespace))
          ?? (await k8s.getServiceInfo(svc.name, svc.namespace));
        if (!info) return status(404, { error: "no Service object found in namespace" });

        // Resolve the port being patched: explicit portName if provided, else the first port.
        const targetPort = parsed.data.portName
          ? info.ports.find((p) => p.name === parsed.data.portName)
          : info.ports[0];
        if (!targetPort) return status(404, { error: `port '${parsed.data.portName ?? "<first>"}' not found on Service` });

        const candidateType = parsed.data.type ?? info.type ?? "ClusterIP";
        if (candidateType !== "ClusterIP" && candidateType !== "NodePort" && candidateType !== "LoadBalancer") {
          return status(422, { error: `unsupported service type '${candidateType}'` });
        }
        const newType: "ClusterIP" | "NodePort" | "LoadBalancer" = candidateType;
        // ClusterIP rejects nodePort. If the operator passed nodePort but didn't switch type, that's a user error.
        if (parsed.data.nodePort !== undefined && newType === "ClusterIP") {
          return status(422, { error: "nodePort can only be set when type is NodePort or LoadBalancer" });
        }
        // NodePort range is a kube-apiserver constraint (default 30000-32767). Catch this here so the
        // operator gets a helpful suggestion instead of a generic kubectl rejection — they probably
        // want externalIPs (any port on any node IP) or LoadBalancer for ports outside the range.
        if (
          parsed.data.nodePort !== undefined &&
          (parsed.data.nodePort < 30000 || parsed.data.nodePort > 32767)
        ) {
          return status(422, {
            error: "nodePort must be in the kube-apiserver range (default 30000-32767)",
            hint: "Para expor numa porta arbitrária (ex: 80, 8090) use externalIPs com o IP do node, ou Service type=LoadBalancer.",
          });
        }

        const newPort = parsed.data.port ?? targetPort.port;
        const newTargetPort = parsed.data.targetPort ?? targetPort.targetPort ?? newPort;
        const newProtocol = (parsed.data.protocol ?? targetPort.protocol ?? "TCP") as "TCP" | "UDP";
        const newNodePort = parsed.data.nodePort ?? (newType !== "ClusterIP" ? targetPort.nodePort ?? undefined : undefined);

        // 1) Patch the Service in-place (no recreation = no data loss, no LB hiccup beyond endpoint flip).
        const svcPatch = buildServicePortPatch({
          portName: targetPort.name ?? parsed.data.portName ?? "default",
          port: newPort,
          targetPort: newTargetPort,
          protocol: newProtocol,
          type: newType,
          nodePort: newNodePort ?? undefined,
          externalIPs: parsed.data.externalIPs,
        });
        const svcRes = await k8s.kubectl([
          "-n", svc.namespace, "patch", "service", "--type=strategic", "-p", JSON.stringify(svcPatch), "--", info.name,
        ]);
        if (svcRes.code !== 0) return status(502, { error: (svcRes.stderr || svcRes.stdout).trim().slice(0, 200) });

        // 2) Patch the Deployment's containerPort. Strategic merge — keys on container name, so
        //    env/volumes/imagePullSecrets stay intact, pods are rolled with the new port.
        //    The HPA continues to observe the Deployment by name → autoscaling untouched.
        const containerPort = typeof newTargetPort === "number" ? newTargetPort : newPort;
        const depPatch = buildDeploymentContainerPortPatch({
          containerName: containerNameFor(svc),
          portName: targetPort.name ?? parsed.data.portName ?? "default",
          containerPort,
          protocol: newProtocol,
        });
        const depRes = await k8s.kubectl([
          "-n", svc.namespace, "patch", workloadKindFor(svc).toLowerCase(), "--type=strategic", "-p", JSON.stringify(depPatch), "--", workloadNameFor(svc),
        ]);
        if (depRes.code !== 0) return status(502, { error: (depRes.stderr || depRes.stdout).trim().slice(0, 200) });

        const finalExternalIPs = parsed.data.externalIPs ?? info.externalIPs ?? [];
        return {
          ok: true,
          service: { name: info.name, namespace: svc.namespace, type: newType, port: newPort, targetPort: newTargetPort, nodePort: newNodePort ?? null, protocol: newProtocol, externalIPs: finalExternalIPs },
          workload: { kind: workloadKindFor(svc), name: workloadNameFor(svc), containerPort },
          loadBalancer: {
            kind: newType,
            message: `kube-proxy continues to route the new port via selector app=${workloadNameFor(svc)}; existing replicas roll one-by-one (no data loss).`,
          },
        };
      },
      { detail: { summary: "Patch the Service port + Deployment containerPort in-place (no recreation, no data loss)", tags: ["service-ops"] } },
    );
};
