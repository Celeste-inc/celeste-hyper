import { loadConfig } from "./config.ts";
import { State } from "./lib/state.ts";
import { R2 } from "./lib/r2.ts";
import { Registry } from "./services/registry.ts";
import { ClusterRegistry } from "./services/cluster-registry.ts";
import { K8sPool } from "./services/k8s-pool.ts";
import { Deployer } from "./services/deploy.ts";
import { Poller } from "./services/poller.ts";
import { Queue } from "./queue/queue.ts";
import { Worker } from "./queue/worker.ts";
import { makeDeployHandler, DEPLOY_JOB_KIND } from "./queue/handlers/deploy.ts";
import { makeRollbackHandler, ROLLBACK_JOB_KIND } from "./queue/handlers/rollback.ts";
import { CapabilityService } from "./services/capability-probe.ts";
import { makeDnsResolver } from "./lib/dns-hint.ts";
import { realVersionProbe } from "./services/network-scan.ts";
import { lockPathFor, readLock, acquireProcessLock, releaseProcessLock } from "./cli/state.ts";
import { recordAudit } from "./lib/audit.ts";
import { Helm } from "./lib/helm.ts";
import { Git } from "./lib/git.ts";
import { effectiveR2Config, R2SourceStore } from "./services/r2-settings.ts";
import { makeHelmUpgradeHandler, HELM_UPGRADE_JOB_KIND } from "./queue/handlers/helm-upgrade.ts";
import { buildApp } from "./routes/_app.ts";
import { log } from "./lib/logger.ts";
import { MigrationError } from "./lib/migrations.ts";
import { realClock } from "./lib/clock.ts";
import { resolveAuthConfig, ensureDefaultAdmin, AuthConfigError, type AuthConfig } from "./lib/auth-config.ts";
import { join } from "node:path";

const cfg = loadConfig();
const clock = realClock();

const dbPath = join(cfg.stateDir, "state.sqlite");
const lockPath = lockPathFor(dbPath);
// PID lock so the offline `state backup`/`restore` CLI refuses to touch a live DB (P2.4). Exclusive
// create — refuses to boot if a live process already holds it; a crash-stale lock is taken over.
if (!acquireProcessLock(lockPath)) {
  log.error("boot.db_locked", { pid: readLock(lockPath).pid, lockPath });
  process.exit(1);
}

let state: State;
try {
  state = new State(dbPath, clock);
} catch (err) {
  log.error("boot.state_init_failed", {
    error: err instanceof Error ? err.message : String(err),
    code: err instanceof MigrationError ? err.code : undefined,
    version: err instanceof MigrationError ? err.version : undefined,
  });
  process.exit(1);
}
let auth: AuthConfig;
try {
  auth = resolveAuthConfig(state);
} catch (err) {
  log.error("boot.auth_config_invalid", {
    error: err instanceof Error ? err.message : String(err),
    code: err instanceof AuthConfigError ? "AUTH_CONFIG" : undefined,
  });
  process.exit(1);
}
await ensureDefaultAdmin(state); // first boot: create the temporary admin/admin (must change on first login)

const r2 = new R2(effectiveR2Config(state, cfg.r2));
const r2Sources = new R2SourceStore(state, cfg.r2, r2);

const seedCluster = cfg.clusters?.[0]
  ? {
      id: cfg.clusters[0].id,
      name: cfg.clusters[0].name,
      kubeconfigPath: cfg.clusters[0].kubeconfigPath,
      defaultNamespace: cfg.clusters[0].defaultNamespace,
      runtime: cfg.clusters[0].runtime,
    }
  : {
      id: "default",
      name: "Local cluster",
      kubeconfigPath: cfg.k8s.kubeconfig ?? "",
      defaultNamespace: cfg.k8s.namespace,
      runtime: cfg.k8s.runtime,
    };

const clusters = ClusterRegistry.bootstrap(state, seedCluster);
const pool = new K8sPool(clusters, clock);

if (cfg.clusters && cfg.clusters.length > 1) {
  for (const c of cfg.clusters.slice(1)) {
    if (!clusters.get(c.id)) clusters.create({ ...c, enabled: true });
  }
}

const defaultClusterId = clusters.list()[0]?.id ?? "default";
const registry = Registry.bootstrap(state, cfg.services, defaultClusterId);
const git = new Git();
const deployer = new Deployer(cfg, r2Sources, pool, state, clock, git);
const helm = new Helm(pool);
const queue = new Queue(state, clock);
const worker = new Worker({
  queue,
  handlers: {
    [DEPLOY_JOB_KIND]: makeDeployHandler({ state, registry, deployer, queue, pool }),
    [ROLLBACK_JOB_KIND]: makeRollbackHandler({ state, registry, pool }),
    [HELM_UPGRADE_JOB_KIND]: makeHelmUpgradeHandler({ state, registry, helm, pool }),
  },
  clock,
  audit: (job, result, message) =>
    recordAudit(
      state,
      { actor: "system", action: `job:${job.kind}`, resourceKind: "service", resourceId: job.resource_id, result, message: message ?? null },
      clock.now(),
    ),
});
const capabilities = new CapabilityService({ state, pool, clock });
capabilities.refreshHost(); // host CLIs don't change at runtime; probe once at boot
void capabilities.checkKubectlVersion(defaultClusterId); // CC.5: warn once if kubectl is below the supported minimum
const dns = makeDnsResolver({ clock });
const poller = new Poller({ cfg, r2Sources, state, registry, deployer, pool, clusters, queue, capabilities, git, clock });

const app = buildApp({ cfg, registry, clusters, pool, state, deployer, r2, r2Sources, poller, queue, capabilities, dns, clock, auth, netProbe: realVersionProbe, helm, git });

poller.start();
worker.start();

app.listen({ hostname: cfg.listen.host, port: cfg.listen.port }, (server) => {
  log.info("listening", { url: `http://${server.hostname}:${server.port}` });
});

const shutdown = async (sig: string) => {
  log.info("shutdown", { signal: sig });
  poller.stop(); // no new auto-deploy enqueues
  await app.stop(); // stop accepting + abort in-flight requests (SSE generators kill their kubectl child)
  const drained = await worker.stop(); // stop claiming; wait (bounded) for the running job
  if (drained) {
    state.close();
  } else {
    // The job outlived the grace period; closing the DB under it would throw on its next write.
    // Leave it open and exit — its lease expires and it's reaped/recovered on the next boot.
    log.warn("shutdown.worker_not_drained", { note: "running job exceeded grace; DB left open" });
  }
  releaseProcessLock(lockPath); // release the PID lock so the offline CLI can operate (P2.4)
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
