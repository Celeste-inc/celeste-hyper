import { Elysia } from "elysia";
import type { ApiDeps } from "./deps.ts";
import { VERSION } from "../version.ts";

export const systemRoutes = (deps: ApiDeps) => {
  const bootMs = deps.clock.now(); // captured once at construction → uptimeSec via the injected clock
  return new Elysia()
    .get(
      "/health",
      () => ({
        ok: true,
        version: VERSION,
        uptimeSec: Math.max(0, Math.floor((deps.clock.now() - bootMs) / 1000)), // clamp a backward wall-clock step
        lastTickAt: deps.poller.getSnapshot().lastTickAt,
        clusterCount: deps.clusters.count(),
        jobCount: deps.queue.outstandingCount(),
      }),
      { detail: { summary: "Liveness + runtime introspection", tags: ["system"] } },
    )
    .get(
      "/system",
      () => {
        const snap = deps.poller.getSnapshot();
        return {
          clusters: deps.clusters.list().length,
          poller: {
            enabled: deps.cfg.poller.enabled,
            intervalSec: deps.cfg.poller.intervalSec,
            autoDeploy: deps.cfg.poller.autoDeploy,
            lastTickAt: snap.lastTickAt,
            lastDurationMs: snap.lastDurationMs,
            lastError: snap.lastError,
          },
          r2: { endpoint: deps.r2.getConfig().endpoint, bucket: deps.r2.getConfig().bucket },
        };
      },
      { detail: { summary: "Aggregate runtime info", tags: ["system"] } },
    );
};
