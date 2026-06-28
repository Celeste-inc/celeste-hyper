import { Elysia, sse } from "elysia";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { ApiDeps } from "./deps.ts";
import { authenticate } from "./auth.ts";
import { withinScope } from "./scope.ts";
import { ExecSession, isValidK8sName, type ExecSocket, type ExecProc } from "../services/exec.ts";
import { log } from "../lib/logger.ts";
import { type Clock, realClock } from "../lib/clock.ts";
import { workloadNameFor, containerNameFor } from "../services/model.ts";
import { findHpaForWorkload, summarizeHpa, validateHpaPatch, buildHpaPatch } from "../services/hpa.ts";
import type { ClusterNode, IngressRule, K8sServiceInfo } from "../lib/k8s.ts";
import type { DnsHint } from "../lib/dns-hint.ts";

const HpaPatchBody = z
  .object({
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    targetCPUUtilizationPercentage: z.number().int().optional(),
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

/** Whether the cluster supports HPA v2, lazily probing once if it has never been checked (so a
 *  cold-start cluster isn't falsely 409'd before the poller's first capability tick runs). */
async function hpaCapable(deps: ApiDeps, clusterId: string): Promise<boolean> {
  let merged = deps.capabilities.merged(clusterId);
  if (merged.lastCheckedAt === null) {
    await deps.capabilities.refreshCluster(clusterId);
    merged = deps.capabilities.merged(clusterId);
  }
  return Boolean(merged.capabilities.hpaV2?.value);
}

export const serviceOpsRoutes = (deps: ApiDeps) => {
  const findPodSelector = async (
    svcName: string,
  ): Promise<{ selector: string; namespace: string; clusterId: string } | null> => {
    const svc = deps.registry.get(svcName);
    if (!svc) return null;
    const k8s = deps.pool.get(svc.clusterId);
    if (!k8s) return null;
    const workload = workloadNameFor(svc);
    const kind = svc.sourceType === "registry-pull" ? svc.workloadKind : "Deployment";
    const selector = await k8s.getWorkloadSelector(kind, workload, svc.namespace);
    if (selector) return { selector, namespace: svc.namespace, clusterId: svc.clusterId };
    return { selector: `app=${svc.name}`, namespace: svc.namespace, clusterId: svc.clusterId };
  };

  /** Confirm `pod`/`container` actually back THIS service (namespaces are shared — same guard as logs). */
  const verifyPodContainer = async (svcName: string, pod: string, container: string): Promise<boolean> => {
    const target = await findPodSelector(svcName);
    if (!target) return false;
    const k8s = deps.pool.get(target.clusterId);
    if (!k8s) return false;
    try {
      const pods = (await k8s.listPods(target.namespace, target.selector)) as Array<{ name?: string; containers?: Array<{ name?: string }> }>;
      const match = pods.find((p) => p.name === pod);
      return Boolean(match && match.containers?.some((c) => c.name === container));
    } catch {
      return false;
    }
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
        const target = await findPodSelector(svc.name);
        if (!target) return { items: [] };
        try {
          const k8s = deps.pool.getOrThrow(target.clusterId);
          const pods = await k8s.listPods(target.namespace, target.selector);
          return { items: pods, selector: target.selector };
        } catch (e) {
          return { items: [], error: (e as Error).message };
        }
      },
      { detail: { summary: "List pods backing a service", tags: ["service-ops"] } },
    )
    .get(
      "/services/:name/events",
      async ({ params, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const target = await findPodSelector(svc.name);
        if (!target) return { items: [] };
        try {
          const k8s = deps.pool.getOrThrow(target.clusterId);
          const pods = await k8s.listPods(target.namespace, target.selector);
          const podNames = new Set(pods.map((p) => p.name));
          const events = await k8s.listEvents(target.namespace);
          // OR across names isn't expressible in kubectl --field-selector; filter client-side to
          // events involving a pod that backs THIS service.
          const items = events
            .filter((e) => e.involvedObject.kind === "Pod" && podNames.has(e.involvedObject.name))
            .sort((a, b) => (b.lastTimestamp ?? "").localeCompare(a.lastTimestamp ?? ""))
            .slice(0, 50);
          return { items };
        } catch (e) {
          return { items: [], error: (e as Error).message };
        }
      },
      { detail: { summary: "List Kubernetes events for pods backing a service", tags: ["service-ops"] } },
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

        // Confine the stream to pods/containers that actually back THIS service. Namespaces are
        // shared, so without this a caller could read any pod's logs via an arbitrary ?pod=.
        let podMatch: { name?: string; containers?: Array<{ name?: string }> } | undefined;
        try {
          const target = await findPodSelector(svc.name);
          const pods = target
            ? ((await k8s.listPods(target.namespace, target.selector)) as Array<{
                name?: string;
                containers?: Array<{ name?: string }>;
              }>)
            : [];
          podMatch = pods.find((p) => p.name === pod);
        } catch {
          return status(502, { error: "unable to verify pod ownership" });
        }
        if (!podMatch) return status(404, { error: "pod not found for this service" });

        const containers = (podMatch.containers ?? []).map((c) => c.name).filter((n): n is string => !!n);
        const container = query.container || containerNameFor(svc);
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
    );
};
