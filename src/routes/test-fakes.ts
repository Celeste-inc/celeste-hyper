import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { ApiDeps } from "./deps.ts";
import type { PollerSnapshot } from "../services/poller.ts";
import type { ClusterHealth } from "../services/k8s-pool.ts";
import { State } from "../lib/state.ts";
import { Registry } from "../services/registry.ts";
import { ClusterRegistry } from "../services/cluster-registry.ts";
import { Queue } from "../queue/queue.ts";
import { CapabilityService } from "../services/capability-probe.ts";
import type { DnsResolver } from "../lib/dns-hint.ts";
import type { VersionProbe } from "../services/network-scan.ts";
import type { HelmLike } from "../lib/helm.ts";
import type { GitLike } from "../lib/git.ts";
import { R2SourceStore } from "../services/r2-settings.ts";
import { realClock, type Clock } from "../lib/clock.ts";

/** Minimal structural fake of the K8s adapter surface the route handlers touch. */
export interface FakeK8s {
  getWorkloadSelector(kind: string, name: string, namespace: string): Promise<string | null>;
  listPods(namespace: string, selector?: string): Promise<unknown[]>;
  listEvents(namespace: string, fieldSelector?: string): Promise<unknown[]>;
  getServiceInfo(name: string, namespace: string): Promise<unknown | null>;
  listNodes(): Promise<unknown[]>;
  listIngressesFor(svc: string, namespace: string): Promise<unknown[]>;
  streamLogs(pod: string, container: string, namespace: string, tail: number): unknown;
  kubectl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  getWorkloadJson(kind: string, name: string, namespace: string): Promise<{ code: number; stdout: string; stderr: string }>;
  getIngressYaml(name: string, namespace: string): Promise<{ code: number; stdout: string; stderr: string }>;
  namespaceCounts(): Promise<unknown>;
  listHpas(namespace: string): Promise<unknown[]>;
  patchHpa(name: string, namespace: string, mergePatch: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface LogProcLike {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: () => void;
  killed: boolean;
}

/**
 * Build a fake `streamLogs` subprocess. In `follow` mode the streams never close and `exited`
 * never resolves (mimics `kubectl logs -f` on an idle pod), so abort handling can be tested.
 */
export function fakeLogProc(stdoutLines: string[], exitCode = 0, follow = false): LogProcLike {
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      if (stdoutLines.length) c.enqueue(enc.encode(stdoutLines.join("\n") + "\n"));
      if (!follow) c.close();
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (c) => {
      if (!follow) c.close();
    },
  });
  const proc: LogProcLike = {
    stdout,
    stderr,
    exited: follow ? new Promise<number>(() => {}) : Promise.resolve(exitCode),
    killed: false,
    kill() {
      proc.killed = true;
    },
  };
  return proc;
}

export interface FakeDepsOptions {
  snapshot?: Partial<PollerSnapshot>;
  /** Override the fake K8s methods, or pass `null` so `pool.get` returns null (cluster not configured). */
  k8s?: Partial<FakeK8s> | null;
  health?: ClusterHealth;
  envFilesDir?: string;
  /** Inject a throwing poller to exercise the 500 path. */
  pollerThrows?: boolean;
  /** Auth: JWT secret used to sign/verify sessions in tests. */
  jwtSecret?: string;
  /** Shared clock for State + deps.clock (pass a fakeClock to control time, e.g. token expiry). */
  clock?: Clock;
  /** DNS resolver for ingress hints; defaults to "unresolved". */
  dns?: DnsResolver;
  /** Network probe for discovery scans (P1.11); defaults to "nothing reachable". */
  netProbe?: VersionProbe;
  /** Helm runner (P2.2); defaults to "command not run". */
  helm?: HelmLike;
  /** Git runner (P2.3); defaults to "command not run". */
  git?: GitLike;
  /** git-sync config override for tests (host allowlist / keys dir). */
  gitConfig?: { hostAllowlist?: string[]; keysDir?: string };
  /** Host-capability `which` (P0.8/P2.2): when provided, host caps are probed (e.g. `helmCli`). */
  which?: (bin: string) => boolean;
}

export const TEST_JWT_SECRET = "test-jwt-secret-000000000000000000";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

function defaultK8s(): FakeK8s {
  return {
    getWorkloadSelector: async () => null,
    listPods: async () => [],
    listEvents: async () => [],
    getServiceInfo: async () => null,
    listNodes: async () => [],
    listIngressesFor: async () => [],
    streamLogs: () => fakeLogProc([]),
    kubectl: async () => ({
      code: 0,
      stdout: "v1\napps/v1\nautoscaling/v2\nnetworking.k8s.io/v1\nmetrics.k8s.io/v1beta1",
      stderr: "",
    }),
    getWorkloadJson: async () => ({ code: 0, stdout: JSON.stringify({ metadata: { annotations: {} } }), stderr: "" }),
    getIngressYaml: async () => ({ code: 0, stdout: "apiVersion: networking.k8s.io/v1\nkind: Ingress\n", stderr: "" }),
    namespaceCounts: async () => ({
      items: [{ name: "default", phase: "Active", createdAt: "2026-01-01T00:00:00Z", deploymentCount: 1, statefulsetCount: 0, daemonsetCount: 0, podCount: 2 }],
      truncated: false,
    }),
    listHpas: async () => [],
    patchHpa: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}

export function makeFakeDeps(opts: FakeDepsOptions = {}): ApiDeps {
  const clock = opts.clock ?? realClock();
  const state = new State(":memory:", clock);
  const clusters = new ClusterRegistry(state);
  const registry = new Registry(state);
  const queue = new Queue(state, clock);

  const envFilesDir = opts.envFilesDir ?? mkdtempSync(join(tmpdir(), "celeste-env-"));

  const cfg = {
    listen: { host: "127.0.0.1", port: 0 },
    r2: { endpoint: "https://r2.test", bucket: "test-bucket", accessKeyId: "x", secretAccessKey: "y", region: "auto" },
    k8s: { runtime: "auto", namespace: "default" },
    stateDir: tmpdir(),
    envFilesDir,
    workDir: tmpdir(),
    poller: { intervalSec: 15, autoDeploy: false, enabled: true },
    services: [],
    git: { hostAllowlist: opts.gitConfig?.hostAllowlist ?? [], keysDir: opts.gitConfig?.keysDir ?? "/etc/celeste-hyper/git-keys" },
  } as unknown as Config;

  const k8s = opts.k8s === null ? null : { ...defaultK8s(), ...(opts.k8s ?? {}) };

  const health = (id: string): ClusterHealth =>
    opts.health ?? { clusterId: id, ok: true, reachable: true, message: "ok", checkedAt: FIXED_TS };

  const pool = {
    get: () => k8s,
    getOrThrow: () => {
      if (!k8s) throw new Error("cluster not configured");
      return k8s;
    },
    getHealth: (id: string) => health(id),
    checkHealth: async (id: string) => health(id),
    invalidate: () => {},
  };

  const baseSnapshot: PollerSnapshot = {
    lastTickAt: null,
    lastDurationMs: null,
    lastError: null,
    cluster: [],
    newVersions: {},
    clusterHealth: [],
  };

  const poller = {
    getSnapshot: () => {
      if (opts.pollerThrows) throw new Error("poller boom");
      return { ...baseSnapshot, ...(opts.snapshot ?? {}) };
    },
    start: () => {},
    stop: () => {},
  };

  const deployer = {
    deployExisting: async () => ({ ok: true }),
  };

  const r2 = {
    bucket: cfg.r2.bucket,
    getConfig: () => ({ ...cfg.r2 }),
    updateConfig: (next: typeof cfg.r2) => {
      cfg.r2 = next;
      r2.bucket = next.bucket;
    },
    listPrefixes: async () => [],
    listObjects: async () => [],
    exists: async () => false,
    download: async () => {},
  };
  const r2Sources = new R2SourceStore(state, cfg.r2, r2);

  const auth = { jwtSecret: opts.jwtSecret ?? TEST_JWT_SECRET };

  const capabilities = new CapabilityService({ state, pool, clock, which: opts.which ?? (() => false) });
  if (opts.which) capabilities.refreshHost(); // seed host caps (e.g. helmCli) when a `which` is given
  const dns: DnsResolver = opts.dns ?? (async () => ({ resolved: false, reason: "no-dns-in-test" }));
  // Default discovery probe: nothing reachable. Tests that exercise discovery override deps.netProbe.
  const netProbe = opts.netProbe ?? (async () => ({ reachable: false, ms: 0 }));
  const helm: HelmLike = opts.helm ?? { run: async () => ({ code: 1, stdout: "", stderr: "helm not run in test" }) };
  const git: GitLike = opts.git ?? { run: async () => ({ code: 1, stdout: "", stderr: "git not run in test" }) };

  return { cfg, registry, clusters, pool, state, deployer, r2, r2Sources, poller, queue, capabilities, dns, clock, auth, netProbe, helm, git } as unknown as ApiDeps;
}
