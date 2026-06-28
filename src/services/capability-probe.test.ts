import { describe, it, expect, spyOn } from "bun:test";
import { State } from "../lib/state.ts";
import { fakeClock } from "../lib/clock.ts";
import type { RunResult } from "../lib/k8s.ts";
import { log } from "../lib/logger.ts";
import {
  probeClusterCapabilities,
  probeHostCapabilities,
  CapabilityService,
  CLUSTER_CAPABILITY_KEYS,
  HOST_CAPABILITY_KEYS,
} from "./capability-probe.ts";

const NOW = "2026-06-28T00:00:00.000Z";

// A realistic `kubectl api-versions` fixture (one group/version per line).
const API_VERSIONS = [
  "v1",
  "apps/v1",
  "autoscaling/v1",
  "autoscaling/v2",
  "networking.k8s.io/v1",
  "metrics.k8s.io/v1beta1",
  "batch/v1",
].join("\n");

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });

describe("probeClusterCapabilities", () => {
  it("extracts hpaV2 from api-versions (autoscaling/v2)", async () => {
    const caps = await probeClusterCapabilities(async () => ok(API_VERSIONS), NOW);
    expect(caps.hpaV2.value).toBe(true);
    expect(caps.hpaV2.source).toBe("cluster");
    expect(caps.hpaV2.lastCheckedAt).toBe(NOW);
  });

  it("extracts ingressV1 / networkingV1 (networking.k8s.io/v1)", async () => {
    const caps = await probeClusterCapabilities(async () => ok(API_VERSIONS), NOW);
    expect(caps.ingressV1.value).toBe(true);
    expect(caps.networkingV1.value).toBe(true);
  });

  it("detects metricsServerV1Beta1 from the API surface only (no /healthz probe)", async () => {
    const withMetrics = await probeClusterCapabilities(async () => ok(API_VERSIONS), NOW);
    expect(withMetrics.metricsServerV1Beta1.value).toBe(true);
    const withoutMetrics = await probeClusterCapabilities(
      async () => ok("v1\napps/v1\nautoscaling/v2\nnetworking.k8s.io/v1"),
      NOW,
    );
    expect(withoutMetrics.metricsServerV1Beta1.value).toBe(false);
  });

  it("statefulSet/daemonSet rollout follow apps/v1", async () => {
    const caps = await probeClusterCapabilities(async () => ok(API_VERSIONS), NOW);
    expect(caps.statefulSetRollout.value).toBe(true);
    expect(caps.daemonSetRollout.value).toBe(true);
  });

  it("survives a kubectl failure — every capability is false with the error attached", async () => {
    const caps = await probeClusterCapabilities(async () => fail("Unable to connect to the server"), NOW);
    for (const key of CLUSTER_CAPABILITY_KEYS) {
      expect(caps[key].value).toBe(false);
      expect(caps[key].error).toContain("Unable to connect");
    }
  });

  it("survives a kubectl that throws", async () => {
    const caps = await probeClusterCapabilities(async () => {
      throw new Error("spawn ENOENT");
    }, NOW);
    expect(caps.hpaV2.value).toBe(false);
    expect(caps.hpaV2.error).toContain("ENOENT");
  });
});

describe("probeHostCapabilities", () => {
  it("missing helm falls back to false", () => {
    const caps = probeHostCapabilities((bin) => bin === "k3s", NOW);
    expect(caps.k3sCli.value).toBe(true);
    expect(caps.helmCli.value).toBe(false);
    expect(caps.ctrCli.value).toBe(false);
    for (const key of HOST_CAPABILITY_KEYS) expect(caps[key].source).toBe("host");
  });
});

describe("CapabilityService", () => {
  function setup() {
    const clock = fakeClock(Date.parse("2026-06-28T00:00:00.000Z"));
    const state = new State(":memory:", clock);
    const k8s = { kubectl: async () => ok(API_VERSIONS) };
    const pool = { get: () => k8s } as never;
    const svc = new CapabilityService({ state, pool, clock, which: (b) => b === "helm" });
    return { clock, state, svc };
  }

  it("refreshCluster persists, and merged() combines cluster + host capabilities", async () => {
    const { svc } = setup();
    svc.refreshHost();
    await svc.refreshCluster("primary");
    const { capabilities, lastCheckedAt } = svc.merged("primary");
    expect(capabilities.hpaV2!.value).toBe(true); // cluster
    expect(capabilities.hpaV2!.source).toBe("cluster");
    expect(capabilities.helmCli!.value).toBe(true); // host
    expect(capabilities.helmCli!.source).toBe("host");
    expect(lastCheckedAt).not.toBeNull();
  });

  it("isStale is true when missing and false right after a refresh; true again after 24h", async () => {
    const { svc, clock } = setup();
    expect(svc.isStale("primary", 24 * 3600_000)).toBe(true);
    await svc.refreshCluster("primary");
    expect(svc.isStale("primary", 24 * 3600_000)).toBe(false);
    clock.advance(24 * 3600_000 + 1);
    expect(svc.isStale("primary", 24 * 3600_000)).toBe(true);
  });

  it("invalidate deletes the cached cluster capabilities", async () => {
    const { svc, state } = setup();
    await svc.refreshCluster("primary");
    expect(state.getClusterCapabilities("primary")).not.toBeNull();
    svc.invalidate("primary");
    expect(state.getClusterCapabilities("primary")).toBeNull();
  });

  it("refreshCluster on an unconfigured cluster yields all-false cluster caps", async () => {
    const clock = fakeClock(0);
    const state = new State(":memory:", clock);
    const svc = new CapabilityService({ state, pool: { get: () => null } as never, clock, which: () => false });
    const map = await svc.refreshCluster("ghost");
    expect(map.hpaV2.value).toBe(false);
    expect(map.hpaV2.error).toContain("kubeconfig");
  });
});

describe("CapabilityService kubectl version skew (CC.5)", () => {
  // A kubectl fake that answers `version` with JSON and everything else (api-versions) with the fixture.
  function versionAwareSvc(opts: { server?: string; client?: string }) {
    const clock = fakeClock(Date.parse(NOW));
    const state = new State(":memory:", clock);
    const k8s = {
      kubectl: async (args: string[]): Promise<RunResult> => {
        if (args[0] === "version") {
          const body: { clientVersion?: { gitVersion: string }; serverVersion?: { gitVersion: string } } = {};
          if (opts.client) body.clientVersion = { gitVersion: opts.client };
          if (opts.server && !args.includes("--client")) body.serverVersion = { gitVersion: opts.server };
          return ok(JSON.stringify(body));
        }
        return ok(API_VERSIONS);
      },
    };
    return { svc: new CapabilityService({ state, pool: { get: () => k8s } as never, clock, which: () => false }), state };
  }

  it("refreshCluster records the apiserver version; merged() exposes it", async () => {
    const { svc } = versionAwareSvc({ server: "v1.31.13+k3s1" });
    await svc.refreshCluster("primary");
    expect(svc.merged("primary").serverVersion).toBe("v1.31.13+k3s1");
  });

  it("checkKubectlVersion stores the client version and kubectlVersion() reads it back", async () => {
    const { svc } = versionAwareSvc({ client: "v1.31.0", server: "v1.31.0" });
    expect(svc.kubectlVersion()).toBeNull();
    await svc.checkKubectlVersion("primary");
    expect(svc.kubectlVersion()).toBe("v1.31.0");
  });

  it("checkKubectlVersion warns when the client is below the supported minimum", async () => {
    const warn = spyOn(log, "warn");
    try {
      const { svc } = versionAwareSvc({ client: "v1.28.0" });
      await svc.checkKubectlVersion("primary");
      expect(warn).toHaveBeenCalledWith("kubectl.below_minimum", expect.objectContaining({ client: "v1.28.0" }));
    } finally {
      warn.mockRestore();
    }
  });

  it("checkKubectlVersion does not warn for a supported client", async () => {
    const warn = spyOn(log, "warn");
    try {
      const { svc } = versionAwareSvc({ client: "v1.31.0" });
      await svc.checkKubectlVersion("primary");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
