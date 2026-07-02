import { Elysia } from "elysia";
import type { ApiDeps } from "./deps.ts";
import { aggregateFleet, type FleetInputs, type DegradedMark } from "../services/fleet.ts";

const RECENT_DEPLOYS_PER_SERVICE = 10;

export const fleetRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/fleet",
      () => {
        const clusters = deps.clusters.list();
        const services = deps.registry.list();
        const snap = deps.poller.getSnapshot();
        const degraded = new Map<string, DegradedMark>();
        for (const svc of services) {
          const d = deps.state.serviceDegraded(svc.name);
          if (d) degraded.set(svc.name, d);
        }
        const recent: FleetInputs["recentDeployments"] = [];
        for (const svc of services) {
          recent.push(...deps.state.recentDeployments(svc.name, RECENT_DEPLOYS_PER_SERVICE));
        }
        const capabilities = new Map(clusters.map((c) => [c.id, deps.capabilities.merged(c.id).capabilities] as const))
          ;
        // Map capabilities to a plain {key: boolean} summary for the fleet view.
        const capSummary = new Map<string, Record<string, boolean>>();
        for (const [id, caps] of capabilities) {
          const obj: Record<string, boolean> = {};
          for (const [k, v] of Object.entries(caps)) {
            if (v && typeof v === "object" && "value" in (v as unknown as Record<string, unknown>)) {
              obj[k] = Boolean((v as { value: boolean }).value);
            }
          }
          capSummary.set(id, obj);
        }
        const unmanagedByCluster = new Map<string, number>();
        for (const w of snap.cluster) {
          if (w.managed || w.category === "infrastructure") continue;
          unmanagedByCluster.set(w.clusterId, (unmanagedByCluster.get(w.clusterId) ?? 0) + 1);
        }
        return aggregateFleet({
          clusters,
          health: snap.clusterHealth,
          services,
          degraded,
          recentDeployments: recent,
          capabilities: capSummary,
          unmanagedByCluster,
          now: deps.clock.now(),
        });
      },
      { detail: { summary: "Federation snapshot across all clusters", tags: ["fleet"] } },
    );
