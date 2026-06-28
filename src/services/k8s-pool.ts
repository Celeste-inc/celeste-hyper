import { K8s } from "../lib/k8s.ts";
import type { K8sLike } from "../lib/k8s-port.ts";
import type { ClusterModel } from "./model.ts";
import type { ClusterRegistry } from "./cluster-registry.ts";
import { type Clock, realClock } from "../lib/clock.ts";
import { log } from "../lib/logger.ts";

export interface ClusterHealth {
  clusterId: string;
  ok: boolean;
  reachable: boolean;
  message?: string;
  checkedAt: string;
}

export class K8sPool {
  private readonly cache = new Map<string, K8sLike>();
  private readonly health = new Map<string, ClusterHealth>();
  private readonly clock: Clock;

  constructor(private readonly registry: ClusterRegistry, clock: Clock = realClock()) {
    this.clock = clock;
  }

  invalidate(id: string): void {
    this.cache.delete(id);
    this.health.delete(id);
  }

  get(id: string): K8sLike | null {
    const existing = this.cache.get(id);
    if (existing) return existing;
    const cluster = this.registry.get(id);
    if (!cluster) return null;
    return this.build(cluster);
  }

  getOrThrow(id: string): K8sLike {
    const k8s = this.get(id);
    if (!k8s) throw new Error(`unknown cluster '${id}'`);
    return k8s;
  }

  private build(cluster: ClusterModel): K8sLike {
    const k8s = new K8s({
      kubeconfig: cluster.kubeconfigPath || undefined,
      runtime: cluster.runtime,
      namespace: cluster.defaultNamespace,
    });
    this.cache.set(cluster.id, k8s);
    return k8s;
  }

  async checkHealth(id: string): Promise<ClusterHealth> {
    const k8s = this.get(id);
    const now = new Date(this.clock.now()).toISOString();
    if (!k8s) {
      const h: ClusterHealth = { clusterId: id, ok: false, reachable: false, message: "no kubeconfig configured", checkedAt: now };
      this.health.set(id, h);
      return h;
    }
    const r = await k8s.kubectl(["get", "--raw=/readyz"]).catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    const ok = r.code === 0 && r.stdout.trim() === "ok";
    const health: ClusterHealth = {
      clusterId: id,
      ok,
      reachable: r.code === 0,
      message: ok ? "ok" : (r.stderr || r.stdout).trim().slice(0, 200) || `kubectl exit ${r.code}`,
      checkedAt: now,
    };
    this.health.set(id, health);
    if (!ok) log.warn("cluster.health_degraded", { id, message: health.message });
    return health;
  }

  getHealth(id: string): ClusterHealth | null {
    return this.health.get(id) ?? null;
  }

  snapshotHealth(): ClusterHealth[] {
    return [...this.health.values()];
  }
}
