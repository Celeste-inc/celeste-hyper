import type { State } from "../lib/state.ts";
import type { ServiceConfig } from "../config.ts";
import { ServiceModelSchema, type ServiceModel } from "./model.ts";
import { log } from "../lib/logger.ts";

function seedFromConfig(svc: ServiceConfig, clusterId: string): ServiceModel {
  return {
    sourceType: "r2-bundle",
      name: svc.name,
      namespace: svc.namespace,
      clusterId,
      r2SourceId: "default",
      r2Prefix: svc.r2Prefix,
    manifestRoot: svc.manifestRoot,
    imageTarPattern: svc.imageTarPattern,
    imageRefPrefix: svc.imageRefPrefix,
    enabled: true,
  };
}

export class Registry {
  constructor(private readonly state: State) {}

  static bootstrap(state: State, configServices: ServiceConfig[], defaultClusterId: string): Registry {
    if (state.countServices() === 0 && configServices.length > 0) {
      for (const c of configServices) {
        try {
          const seeded = seedFromConfig(c, defaultClusterId);
          ServiceModelSchema.parse(seeded);
          state.upsertService(seeded);
        } catch (err) {
          log.warn("registry.seed_failed", { name: c.name, error: (err as Error).message });
        }
      }
      log.info("registry.seeded", { count: configServices.length });
    }
    return new Registry(state);
  }

  list(): ServiceModel[] {
    return this.state.listServices();
  }

  listByCluster(clusterId: string): ServiceModel[] {
    return this.list().filter((s) => s.clusterId === clusterId);
  }

  get(name: string): ServiceModel | null {
    return this.state.getService(name);
  }

  create(svc: ServiceModel): ServiceModel {
    if (this.state.getService(svc.name)) {
      throw new Error(`service '${svc.name}' already exists`);
    }
    this.state.upsertService(svc);
    log.info("registry.created", { name: svc.name, sourceType: svc.sourceType, clusterId: svc.clusterId });
    return svc;
  }

  update(name: string, patch: Partial<ServiceModel>): ServiceModel {
    const existing = this.state.getService(name);
    if (!existing) throw new Error(`service '${name}' not found`);
    if (patch.sourceType && patch.sourceType !== existing.sourceType) {
      throw new Error("sourceType cannot be changed; delete and recreate");
    }
    const merged = { ...existing, ...patch } as ServiceModel;
    ServiceModelSchema.parse(merged);
    this.state.upsertService(merged);
    log.info("registry.updated", { name });
    return merged;
  }

  delete(name: string): boolean {
    const ok = this.state.deleteService(name);
    if (ok) log.info("registry.deleted", { name });
    return ok;
  }
}
