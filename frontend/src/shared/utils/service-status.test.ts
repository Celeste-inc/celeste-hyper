import { describe, it, expect } from "vitest";
import { computeServiceStatus } from "./service-status";

const cluster = (replicas: number, ready: number) => ({
  kind: "Deployment" as const,
  replicas,
  readyReplicas: ready,
  containers: [],
});

describe("computeServiceStatus", () => {
  it("returns 'ok' when every replica is ready and no deploy is in flight", () => {
    expect(
      computeServiceStatus({ cluster: cluster(2, 2), activeDeployment: null }),
    ).toMatchObject({ tone: "ok", label: "2/2 ready" });
  });

  it("returns 'deploying' (yellow) — not 'bad' — when a deployment is in 'pending' status", () => {
    const res = computeServiceStatus({
      cluster: cluster(2, 0),
      activeDeployment: { status: "pending", started_at: "2026-06-29T12:00:00Z" },
    });
    expect(res.tone).toBe("warn");
    expect(res.label).toMatch(/deploy/i);
  });

  it("returns 'deploying' for downloading/applying/loading statuses", () => {
    for (const status of ["downloading", "loading", "applying"]) {
      const res = computeServiceStatus({
        cluster: cluster(2, 0),
        activeDeployment: { status, started_at: "2026-06-29T12:00:00Z" },
      });
      expect(res.tone).toBe("warn");
      expect(res.label).toMatch(/deploy/i);
    }
  });

  it("returns 'bad' when replicas > 0 but none ready AND no in-flight deploy AND has been long enough", () => {
    const res = computeServiceStatus({
      cluster: cluster(2, 0),
      activeDeployment: null,
    });
    expect(res.tone).toBe("bad");
  });

  it("returns 'pending' (yellow) when the workload was just created and replicas=0", () => {
    expect(
      computeServiceStatus({ cluster: cluster(0, 0), activeDeployment: null }).tone,
    ).toBe("warn");
  });

  it("returns 'warn' when the deployment is in a terminal failed status (visible distinction)", () => {
    const res = computeServiceStatus({
      cluster: cluster(2, 0),
      activeDeployment: { status: "failed", finished_at: "2026-06-29T12:00:00Z", started_at: "2026-06-29T11:59:00Z" },
    });
    expect(res.tone).toBe("bad");
    expect(res.label).toMatch(/failed/i);
  });

  it("falls back to 'unknown' when there's no cluster info at all", () => {
    expect(
      computeServiceStatus({ cluster: null, activeDeployment: null }).tone,
    ).toBe("warn");
  });

  it("done deployment + all ready → ok", () => {
    const res = computeServiceStatus({
      cluster: cluster(3, 3),
      activeDeployment: { status: "done", started_at: "2026-06-29T11:00:00Z", finished_at: "2026-06-29T11:05:00Z" },
    });
    expect(res.tone).toBe("ok");
  });
});
