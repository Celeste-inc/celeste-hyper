import { describe, expect, it } from "bun:test";
import { AlertWatcher } from "./watcher.ts";
import { evaluatePods, type RawPodStatus } from "./cluster-scan.ts";
import type { Alert } from "./types.ts";
import { envWarnings } from "./index.ts";

const NOW = new Date("2026-10-07T20:00:00Z");

function pod(over: { name?: string; restartCount?: number; waiting?: string; lastReason?: string; ready?: boolean; readySince?: string; app?: string } = {}): RawPodStatus {
  return {
    metadata: { name: over.name ?? "sollo-api-6bbc74667c-hbql6", namespace: "sollo-prod", labels: { app: over.app ?? "sollo-api" } },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: over.ready === false ? "False" : "True", lastTransitionTime: over.readySince ?? "2026-10-07T19:00:00Z" }],
      containerStatuses: [{
        name: "app",
        ready: over.ready !== false,
        restartCount: over.restartCount ?? 0,
        state: over.waiting ? { waiting: { reason: over.waiting, message: "back-off 5m0s" } } : { running: { startedAt: "2026-10-07T19:00:00Z" } },
        lastState: over.lastReason ? { terminated: { reason: over.lastReason, exitCode: 137, finishedAt: "2026-10-07T19:59:00Z" } } : {},
      }],
    },
  };
}

describe("evaluatePods", () => {
  it("raises crashloop as an open condition and OOM restarts as critical", () => {
    const crash = evaluatePods([pod({ waiting: "CrashLoopBackOff", restartCount: 5 })], new Map(), NOW, 300, "local");
    expect(crash.alerts.map((a) => [a.category, a.severity, a.condition])).toEqual([["pod-crashloop", "critical", true]]);
    const oom = evaluatePods([pod({ restartCount: 3, lastReason: "OOMKilled" })], new Map([["sollo-prod/sollo-api-6bbc74667c-hbql6/app", 2]]), NOW, 300, "local");
    expect(oom.alerts.map((a) => a.category)).toEqual(["pod-oom"]);
    const again = evaluatePods([pod({ restartCount: 4, lastReason: "OOMKilled" })], new Map([["sollo-prod/sollo-api-6bbc74667c-hbql6/app", 3]]), NOW, 300, "local");
    expect(again.alerts[0]!.key).toBe(oom.alerts[0]!.key);
  });

  it("does not alert on the first observation of restarts and flags pods not ready past the grace period", () => {
    expect(evaluatePods([pod({ restartCount: 4 })], new Map(), NOW, 300, "local").alerts).toEqual([]);
    const notReady = evaluatePods([pod({ ready: false, readySince: "2026-10-07T19:50:00Z" })], new Map(), NOW, 300, "local");
    expect(notReady.alerts.map((a) => a.category)).toEqual(["pod-not-ready"]);
    expect(evaluatePods([pod({ ready: false, readySince: "2026-10-07T19:58:00Z" })], new Map(), NOW, 300, "local").alerts).toEqual([]);
  });
});

describe("envWarnings", () => {
  it("keeps only env related warnings from a deployment message", () => {
    expect(envWarnings("[warn] config: keys present only in the cluster: A · [warn] something else · [warn] keys defined in both config.env and secret.env: B"))
      .toEqual(["[warn] config: keys present only in the cluster: A", "[warn] keys defined in both config.env and secret.env: B"]);
  });
});

describe("AlertWatcher", () => {
  it("collects pod, event and log alerts per namespace, advances cursors and reports unreadable namespaces", async () => {
    const cycles: { alerts: Alert[]; scopes: Set<string> | null }[] = [];
    const manager = { runCycle: async (alerts: Alert[], scopes: Set<string> | null) => { cycles.push({ alerts, scopes }); return { sent: 0, suppressed: 0, resolved: 0, overflow: 0, failed: 0 }; } };
    const cursors = new Map<string, string>();
    const calls: string[][] = [];
    const k8s = {
      kubectl: async (args: string[]) => {
        calls.push(args);
        if (args[args.indexOf("-n") + 1] === "broken") return { code: 1, stdout: "", stderr: "forbidden" };
        if (args.includes("pods")) return { code: 0, stdout: JSON.stringify({ items: [pod({ waiting: "CrashLoopBackOff", restartCount: 2 })] }), stderr: "" };
        if (args.includes("events")) return { code: 0, stdout: JSON.stringify({ items: [{ type: "Warning", reason: "Unhealthy", message: "Readiness probe failed", involvedObject: { kind: "Pod", name: "sollo-api-6bbc74667c-hbql6" }, lastTimestamp: "2026-10-07T19:59:30Z" }] }), stderr: "" };
        if (args.includes("logs")) return { code: 0, stdout: "2026-10-07T19:59:40.000000001Z {\"level\":\"error\",\"event\":\"api.unhandled_error\",\"path\":\"/v1/x\"}\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const watcher = new AlertWatcher({
      manager: manager as never,
      targets: () => [{ clusterId: "local", namespace: "sollo-prod" }, { clusterId: "local", namespace: "sollo-prod" }, { clusterId: "local", namespace: "broken" }],
      k8s: () => k8s as never,
      cursors: { getCursor: (k) => cursors.get(k) ?? null, setCursor: (k, v) => void cursors.set(k, v) },
      intervalSec: 60,
      notReadyGraceSec: 300,
      logs: true,
      events: true,
      maxLogBytes: 100000,
      maxFindingsPerContainer: 50,
      ignore: [],
      now: () => NOW,
    });
    await watcher.tick();
    const { alerts, scopes } = cycles[0]!;
    expect(alerts.map((a) => a.category).sort()).toEqual(["app-error", "k8s-event", "pod-crashloop", "watcher-error"]);
    expect([...scopes!]).toEqual(["local/sollo-prod"]);
    expect(alerts.find((a) => a.category === "app-error")!.title).toBe("Erro registrado em sollo-api: api.unhandled_error");
    expect(cursors.get("prev:local/sollo-prod/sollo-api-6bbc74667c-hbql6/app")).toBe("2");
    expect(calls.filter((c) => c.includes("--previous"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("pods"))).toHaveLength(2);
    await watcher.tick();
    expect(calls.filter((c) => c.includes("--previous"))).toHaveLength(1);
  });
});
