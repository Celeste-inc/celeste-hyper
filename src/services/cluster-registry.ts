import type { State } from "../lib/state.ts";
import { ClusterModelSchema, type ClusterModel } from "./model.ts";
import { log } from "../lib/logger.ts";

export interface BootstrapClusterSeed {
  id?: string;
  name?: string;
  kubeconfigPath?: string;
  defaultNamespace?: string;
  runtime?: ClusterModel["runtime"];
}

export class ClusterRegistry {
  constructor(private readonly state: State) {}

  static bootstrap(state: State, seed: BootstrapClusterSeed | null): ClusterRegistry {
    if (state.countClusters() === 0 && seed) {
      const candidate: ClusterModel = {
        id: seed.id ?? "default",
        name: seed.name ?? "Local cluster",
        kubeconfigPath: seed.kubeconfigPath ?? "",
        defaultNamespace: seed.defaultNamespace ?? "default",
        runtime: seed.runtime ?? "auto",
        enabled: true,
      };
      const parsed = ClusterModelSchema.safeParse(candidate);
      if (parsed.success) {
        state.upsertCluster(parsed.data);
        log.info("clusters.seeded", { id: parsed.data.id });
      } else {
        log.warn("clusters.seed_failed", { issues: parsed.error.issues });
      }
    }
    return new ClusterRegistry(state);
  }

  list(): ClusterModel[] {
    return this.state.listClusters();
  }

  /** Number of configured clusters, without materialising + JSON-parsing every spec (used by /api/health). */
  count(): number {
    return this.state.countClusters();
  }

  get(id: string): ClusterModel | null {
    return this.state.getCluster(id);
  }

  create(cluster: ClusterModel): ClusterModel {
    if (this.state.getCluster(cluster.id)) {
      throw new Error(`cluster '${cluster.id}' already exists`);
    }
    this.state.upsertCluster(cluster);
    log.info("clusters.created", { id: cluster.id });
    return cluster;
  }

  update(id: string, patch: Partial<ClusterModel>): ClusterModel {
    const existing = this.state.getCluster(id);
    if (!existing) throw new Error(`cluster '${id}' not found`);
    if (patch.id && patch.id !== id) {
      throw new Error("cluster id is immutable");
    }
    const merged = { ...existing, ...patch, id } as ClusterModel;
    ClusterModelSchema.parse(merged);
    this.state.upsertCluster(merged);
    log.info("clusters.updated", { id });
    return merged;
  }

  delete(id: string): boolean {
    if (this.state.countServicesByCluster(id) > 0) {
      throw new Error(`cluster '${id}' still has services attached; remove or migrate them first`);
    }
    const ok = this.state.deleteCluster(id);
    if (ok) log.info("clusters.deleted", { id });
    return ok;
  }
}
