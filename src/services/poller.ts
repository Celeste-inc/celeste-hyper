import type { Config } from "../config.ts";
import type { State } from "../lib/state.ts";
import type { Registry } from "./registry.ts";
import type { Deployer } from "./deploy.ts";
import type { K8sPool, ClusterHealth } from "./k8s-pool.ts";
import type { ClusterRegistry } from "./cluster-registry.ts";
import type { Queue } from "../queue/queue.ts";
import type { CapabilityService } from "./capability-probe.ts";
import { DEPLOY_JOB_KIND } from "../queue/handlers/deploy.ts";
import { type Clock, realClock } from "../lib/clock.ts";

const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
import { listVersions, latest } from "./discovery.ts";
import { parseLsRemote, validateGitUrl, type GitLike } from "../lib/git.ts";
import type { R2SourceStore } from "./r2-settings.ts";
import { discoverWorkloads, type DiscoveredWorkload } from "./cluster.ts";
import { log } from "../lib/logger.ts";

export interface PollerOpts {
  cfg: Config;
  r2Sources: R2SourceStore;
  state: State;
  registry: Registry;
  deployer: Deployer;
  pool: K8sPool;
  clusters: ClusterRegistry;
  queue: Queue;
  capabilities: CapabilityService;
  git?: GitLike;
  clock?: Clock;
}

export interface PollerSnapshot {
  lastTickAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  cluster: DiscoveredWorkload[];
  newVersions: Record<string, string>;
  clusterHealth: ClusterHealth[];
}

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private snapshot: PollerSnapshot = {
    lastTickAt: null,
    lastDurationMs: null,
    lastError: null,
    cluster: [],
    newVersions: {},
    clusterHealth: [],
  };

  private readonly clock: Clock;

  constructor(private readonly opts: PollerOpts) {
    this.clock = opts.clock ?? realClock();
  }

  start(): void {
    if (!this.opts.cfg.poller.enabled) {
      log.info("poller.disabled");
      return;
    }
    const interval = this.opts.cfg.poller.intervalSec * 1000;
    log.info("poller.start", {
      intervalSec: this.opts.cfg.poller.intervalSec,
      autoDeploy: this.opts.cfg.poller.autoDeploy,
    });
    this.timer = setInterval(() => void this.tick(), interval);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(): PollerSnapshot {
    return this.snapshot;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const t0 = this.clock.now();
    const newVersions: Record<string, string> = {};
    const cluster: DiscoveredWorkload[] = [];
    const clusterHealth: ClusterHealth[] = [];
    let lastError: string | null = null;

    try {
      for (const c of this.opts.clusters.list()) {
        if (!c.enabled) continue;
        const health = await this.opts.pool.checkHealth(c.id);
        clusterHealth.push(health);
        if (!health.reachable) {
          lastError = `cluster ${c.id}: ${health.message ?? "unreachable"}`;
          continue;
        }
        const k8s = this.opts.pool.getOrThrow(c.id);
        if (this.opts.capabilities.isStale(c.id, CAPABILITY_TTL_MS)) {
          await this.opts.capabilities.refreshCluster(c.id); // 24 h cadence, alongside health
        }
        try {
          const overrides = this.opts.state.workloadOverrides(c.id);
          const workloads = await discoverWorkloads(c, k8s, this.opts.registry, overrides);
          cluster.push(...workloads);
        } catch (e) {
          lastError = `cluster ${c.id}: ${(e as Error).message}`;
          log.warn("poller.cluster_error", { clusterId: c.id, error: (e as Error).message });
        }
      }

      for (const svc of this.opts.registry.list()) {
        if (!svc.enabled) continue;
        if (svc.sourceType === "git-sync") {
          // ls-remote the ref for its tip sha (bounded by Git.run's 10s timeout; one in flight at a
          // time across the sequential loop, well under the max-4 cap). A timeout → no new version.
          if (!this.opts.git) continue;
          // Re-validate against the (possibly-shrunk) allowlist before contacting the host.
          if (!validateGitUrl(svc.gitUrl, this.opts.cfg.git.hostAllowlist).ok) continue;
          try {
            const r = await this.opts.git.run(["ls-remote", "--", svc.gitUrl, svc.gitRef], { sshKey: svc.deployKeyPath });
            const sha = parseLsRemote(r.stdout);
            if (!sha || this.opts.state.getCurrent(svc.name)?.tag === sha) continue;
            newVersions[svc.name] = sha;
            if (this.opts.cfg.poller.autoDeploy && !this.opts.queue.hasActiveJob(svc.name, DEPLOY_JOB_KIND) && !this.opts.state.serviceDegraded(svc.name)) {
              const id = this.opts.state.recordDeploymentStart(svc.name, sha);
              this.opts.queue.enqueue({ id, kind: DEPLOY_JOB_KIND, resourceKind: "service", resourceId: svc.name, payload: { tag: sha } });
            }
          } catch (e) {
            log.error("poller.service_error", { service: svc.name, error: (e as Error).message });
          }
          continue;
        }
        if (svc.sourceType !== "r2-bundle") continue;
        try {
          const versions = await listVersions(this.opts.r2Sources.clientFor(svc.r2SourceId), svc);
          const newest = latest(versions);
          if (!newest) continue;
          const current = this.opts.state.getCurrent(svc.name);
          if (current?.tag === newest.tag) continue;
          newVersions[svc.name] = newest.tag;
          log.info("poller.new_version", {
            service: svc.name,
            current: current?.tag,
            latest: newest.tag,
          });
          if (
            this.opts.cfg.poller.autoDeploy &&
            !this.opts.queue.hasActiveJob(svc.name, DEPLOY_JOB_KIND) &&
            !this.opts.state.serviceDegraded(svc.name) // never auto-deploy a degraded service (P1.9)
          ) {
            // Route auto-deploys through the queue too, so they share the per-service lock +
            // fencing with operator-triggered deploys (no two concurrent deploys of one service).
            // The hasActiveJob guard avoids piling a duplicate job every tick while one is in flight.
            const id = this.opts.state.recordDeploymentStart(svc.name, newest.tag);
            this.opts.queue.enqueue({
              id,
              kind: DEPLOY_JOB_KIND,
              resourceKind: "service",
              resourceId: svc.name,
              payload: { tag: newest.tag },
            });
          }
        } catch (e) {
          log.error("poller.service_error", { service: svc.name, error: (e as Error).message });
        }
      }
    } finally {
      this.snapshot = {
        lastTickAt: new Date(this.clock.now()).toISOString(),
        lastDurationMs: this.clock.now() - t0,
        lastError,
        cluster,
        newVersions,
        clusterHealth,
      };
      this.running = false;
    }
  }
}
