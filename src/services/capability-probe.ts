import type { RunResult } from "../lib/k8s.ts";
import type { State } from "../lib/state.ts";
import { type Clock, realClock } from "../lib/clock.ts";
import { log } from "../lib/logger.ts";
import { parseKubectlVersion, isClientSupported, MIN_KUBECTL } from "../lib/kube-version.ts";

export interface Capability {
  value: boolean;
  source: "cluster" | "host";
  lastCheckedAt: string;
  error?: string;
}

/** Cluster-level (per cluster) — detected from the cluster's served API group/versions. */
export const CLUSTER_CAPABILITY_KEYS = [
  "ingressV1",
  "networkingV1",
  "hpaV2",
  "metricsServerV1Beta1",
  "statefulSetRollout",
  "daemonSetRollout",
] as const;

/** Host-level (per hyper process) — detected via `which`; applies to every cluster served. */
export const HOST_CAPABILITY_KEYS = ["helmCli", "k3sCli", "ctrCli"] as const;

export type ClusterCapabilityKey = (typeof CLUSTER_CAPABILITY_KEYS)[number];
export type HostCapabilityKey = (typeof HOST_CAPABILITY_KEYS)[number];
export type CapabilityKey = ClusterCapabilityKey | HostCapabilityKey;
export type ClusterCapabilityMap = Record<ClusterCapabilityKey, Capability>;
export type HostCapabilityMap = Record<HostCapabilityKey, Capability>;
/** Stored/merged map — partial because host probing or a missing cluster row can leave gaps. */
export type CapabilityMap = Partial<Record<CapabilityKey, Capability>>;

const HOST_BINS: Record<HostCapabilityKey, string> = { helmCli: "helm", k3sCli: "k3s", ctrCli: "ctr" };

/** Minimal pool surface the probe needs (so test fakes need only `kubectl`). */
export interface CapabilityPool {
  get(id: string): { kubectl(args: string[]): Promise<RunResult> } | null;
}

// Each required capability maps to the presence of a `group/version` in `kubectl api-versions`.
// (The plan named `api-resources -o json`, but its JSON shape isn't stable across kubectl builds;
//  `api-versions` — documented as one `group/version` per line — covers every capability we gate on.)
function clusterFlags(versions: Set<string>): Record<ClusterCapabilityKey, boolean> {
  const has = (gv: string) => versions.has(gv);
  return {
    ingressV1: has("networking.k8s.io/v1"),
    networkingV1: has("networking.k8s.io/v1"),
    hpaV2: has("autoscaling/v2"),
    metricsServerV1Beta1: has("metrics.k8s.io/v1beta1"),
    statefulSetRollout: has("apps/v1"),
    daemonSetRollout: has("apps/v1"),
  };
}

/** Probe cluster-level capabilities by running `kubectl api-versions`. Never throws. */
export async function probeClusterCapabilities(
  kubectl: (args: string[]) => Promise<RunResult>,
  lastCheckedAt: string,
): Promise<ClusterCapabilityMap> {
  // `--request-timeout` bounds a hung/unreachable apiserver so the probe (and the HTTP request or
  // poller tick that awaits it) can't stall indefinitely.
  const r = await kubectl(["api-versions", "--request-timeout=5s"]).catch(
    (e): RunResult => ({ code: 1, stdout: "", stderr: (e as Error).message }),
  );
  const map = {} as ClusterCapabilityMap;
  if (r.code !== 0) {
    const error = (r.stderr || r.stdout).trim().slice(0, 200) || `kubectl exit ${r.code}`;
    for (const key of CLUSTER_CAPABILITY_KEYS) map[key] = { value: false, source: "cluster", lastCheckedAt, error };
    return map;
  }
  const versions = new Set(r.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const flags = clusterFlags(versions);
  for (const key of CLUSTER_CAPABILITY_KEYS) map[key] = { value: flags[key], source: "cluster", lastCheckedAt };
  return map;
}

/** Probe host-level CLI availability. `which` is injected for testability. Never throws. */
export function probeHostCapabilities(which: (bin: string) => boolean, lastCheckedAt: string): HostCapabilityMap {
  const map = {} as HostCapabilityMap;
  for (const key of HOST_CAPABILITY_KEYS) {
    try {
      map[key] = { value: which(HOST_BINS[key]), source: "host", lastCheckedAt };
    } catch (e) {
      map[key] = { value: false, source: "host", lastCheckedAt, error: (e as Error).message };
    }
  }
  return map;
}

function defaultWhich(bin: string): boolean {
  // Pass `bin` as an argv parameter ($1), never interpolated into the script — no shell injection.
  return Bun.spawnSync(["sh", "-c", 'command -v "$1" >/dev/null 2>&1', "sh", bin]).exitCode === 0;
}

/** Probe a cluster's apiserver gitVersion via `kubectl version -o json` (CC.5). Null if unreachable/unparseable. */
export async function probeServerVersion(kubectl: (args: string[]) => Promise<RunResult>): Promise<string | null> {
  const r = await kubectl(["version", "-o", "json", "--request-timeout=5s"]).catch(
    (e): RunResult => ({ code: 1, stdout: "", stderr: (e as Error).message }),
  );
  return parseKubectlVersion(r.stdout).server; // server absent when unreachable; client is ignored here
}

const HOST_CAPS_META_KEY = "host_capabilities";
const KUBECTL_VERSION_META_KEY = "kubectl_version";

export interface CapabilityServiceOpts {
  state: State;
  pool: CapabilityPool;
  clock?: Clock;
  which?: (bin: string) => boolean;
}

/**
 * Owns capability detection + persistence. Cluster-level results are cached per cluster in
 * `cluster_capabilities`; host-level results live in `meta`. `merged()` combines both for the API.
 */
export class CapabilityService {
  private readonly state: State;
  private readonly pool: CapabilityPool;
  private readonly clock: Clock;
  private readonly which: (bin: string) => boolean;

  constructor(opts: CapabilityServiceOpts) {
    this.state = opts.state;
    this.pool = opts.pool;
    this.clock = opts.clock ?? realClock();
    this.which = opts.which ?? defaultWhich;
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Probe + persist cluster-level capabilities (and the apiserver version, CC.5) for one cluster. */
  async refreshCluster(id: string): Promise<ClusterCapabilityMap> {
    const now = this.now();
    const k8s = this.pool.get(id);
    let map: ClusterCapabilityMap;
    let serverVersion: string | null = null;
    if (!k8s) {
      map = {} as ClusterCapabilityMap;
      for (const key of CLUSTER_CAPABILITY_KEYS) {
        map[key] = { value: false, source: "cluster", lastCheckedAt: now, error: "no kubeconfig configured" };
      }
    } else {
      // Independent probes — run them concurrently so an unreachable apiserver costs one timeout, not two.
      [map, serverVersion] = await Promise.all([
        probeClusterCapabilities((args) => k8s.kubectl(args), now),
        probeServerVersion((args) => k8s.kubectl(args)),
      ]);
    }
    this.state.setClusterCapabilities(id, JSON.stringify(map), now, serverVersion);
    return map;
  }

  /**
   * Probe the kubectl client version once (boot) and warn if it's below the documented minimum (CC.5).
   * `--client` contacts no apiserver, so any cluster's runner works. Persisted for the clusters API to
   * compute per-cluster skew against each apiserver's version.
   */
  async checkKubectlVersion(clusterId: string): Promise<string | null> {
    const k8s = this.pool.get(clusterId);
    if (!k8s) return null;
    const r = await k8s
      .kubectl(["version", "--client", "-o", "json"])
      .catch((e): RunResult => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    const client = parseKubectlVersion(r.stdout).client;
    this.state.setMeta(KUBECTL_VERSION_META_KEY, client ?? "");
    if (client && !isClientSupported(client)) {
      log.warn("kubectl.below_minimum", { client, minimum: MIN_KUBECTL });
    }
    return client;
  }

  /** The probed kubectl client version (host-level), or null if not yet probed. */
  kubectlVersion(): string | null {
    return this.state.getMeta(KUBECTL_VERSION_META_KEY) || null;
  }

  /** Probe + persist host-level capabilities (once at boot, refreshable). */
  refreshHost(): HostCapabilityMap {
    const map = probeHostCapabilities(this.which, this.now());
    this.state.setMeta(HOST_CAPS_META_KEY, JSON.stringify(map));
    return map;
  }

  // Defensive: stored capability JSON is always written by us, but a corrupt/truncated row must
  // degrade to "unknown" ({}) rather than 500 the GET that merges it.
  private parse(raw: string | null): CapabilityMap {
    if (!raw) return {};
    try {
      return JSON.parse(raw) as CapabilityMap;
    } catch {
      log.warn("capabilities.corrupt_cache", { note: "ignoring unparseable capability JSON" });
      return {};
    }
  }

  hostCapabilities(): CapabilityMap {
    return this.parse(this.state.getMeta(HOST_CAPS_META_KEY));
  }

  /** Merged cluster + host capabilities for the API, with the cluster row's check time + apiserver version. */
  merged(id: string): { capabilities: CapabilityMap; lastCheckedAt: string | null; serverVersion: string | null } {
    const row = this.state.getClusterCapabilities(id);
    const cluster = this.parse(row?.capabilities ?? null);
    return {
      capabilities: { ...cluster, ...this.hostCapabilities() },
      lastCheckedAt: row?.last_checked_at ?? null,
      serverVersion: row?.server_version ?? null,
    };
  }

  /** True if the cluster's cached capabilities are missing or older than `maxAgeMs` (poller cadence). */
  isStale(id: string, maxAgeMs: number): boolean {
    const row = this.state.getClusterCapabilities(id);
    if (!row) return true;
    const checkedAt = Date.parse(row.last_checked_at);
    if (Number.isNaN(checkedAt)) return true; // corrupt timestamp → treat as stale, don't lock forever
    return this.clock.now() - checkedAt >= maxAgeMs;
  }

  invalidate(id: string): void {
    this.state.deleteClusterCapabilities(id);
  }
}
