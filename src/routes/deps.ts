import type { Config } from "../config.ts";
import type { Registry } from "../services/registry.ts";
import type { ClusterRegistry } from "../services/cluster-registry.ts";
import type { K8sPool } from "../services/k8s-pool.ts";
import type { Deployer } from "../services/deploy.ts";
import type { State } from "../lib/state.ts";
import type { R2Like } from "../lib/r2-port.ts";
import type { Poller } from "../services/poller.ts";
import type { Queue } from "../queue/queue.ts";
import type { CapabilityService } from "../services/capability-probe.ts";
import type { DnsResolver } from "../lib/dns-hint.ts";
import type { Clock } from "../lib/clock.ts";
import type { AuthConfig } from "../lib/auth-config.ts";
import type { VersionProbe } from "../services/network-scan.ts";
import type { HelmLike } from "../lib/helm.ts";
import type { GitLike } from "../lib/git.ts";
import type { R2SourceStore } from "../services/r2-settings.ts";
import type { RegistrySourceStore } from "../services/registry-sources.ts";

/** Dependencies injected into every route plugin (closure-captured, no globals). */
export interface ApiDeps {
  cfg: Config;
  registry: Registry;
  clusters: ClusterRegistry;
  pool: K8sPool;
  state: State;
  deployer: Deployer;
  r2: R2Like;
  r2Sources: R2SourceStore;
  registrySources: RegistrySourceStore;
  poller: Poller;
  queue: Queue;
  capabilities: CapabilityService;
  dns: DnsResolver;
  clock: Clock;
  auth: AuthConfig;
  /** Network probe for cluster discovery (P1.11); injectable so tests avoid real sockets. */
  netProbe: VersionProbe;
  /** Helm CLI runner (P2.2); injectable so tests avoid spawning `helm`. */
  helm: HelmLike;
  /** Git CLI runner (P2.3 git-sync); injectable so tests avoid spawning `git`. */
  git: GitLike;
  /** HTTP fetch for outbound calls (Docker Hub search); injectable for tests. */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}
