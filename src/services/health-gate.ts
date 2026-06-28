import type { Clock } from "../lib/clock.ts";

export interface HealthGateConfig {
  attempts: number;
  intervalSec: number;
  successThreshold: number;
}

export interface HealthGatePodSample {
  phase: string;
  maxRestarts: number;
  waitingReason?: string;
  terminatedReason?: string;
}

export interface HealthGateSample {
  readyReplicas: number;
  replicas: number;
  observedGeneration: number;
  generation: number;
  pods: HealthGatePodSample[];
}

export interface HealthGateResult {
  attempts: number;
  ok: boolean;
  lastReason: string;
}

export const DEFAULT_HEALTH_GATE: HealthGateConfig = { attempts: 6, intervalSec: 5, successThreshold: 3 };

// Container waiting reasons that mean the rollout is broken — fail the gate immediately.
const FATAL_WAITING = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"]);

function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(() => resolve(), ms);
  });
}

/**
 * Poll a workload's steady-state health after `kubectl rollout status` returns. Passes only when
 * readyReplicas == replicas for `successThreshold` consecutive samples; fails fast on
 * CrashLoopBackOff/ImagePullBackOff/ErrImagePull/OOMKilled or a restartCount jump ≥ 2 within the
 * window; and fails on observedGeneration ≠ generation at timeout. `sample` is injected for testing.
 */
export async function runHealthGate(
  sample: () => Promise<HealthGateSample>,
  gate: HealthGateConfig,
  clock: Clock,
): Promise<HealthGateResult> {
  let consecutive = 0;
  let baselineRestarts: number | null = null;
  let attemptsUsed = 0;
  let lastReason = "pending";
  let last: HealthGateSample | null = null;

  for (let i = 0; i < gate.attempts; i++) {
    await delay(clock, gate.intervalSec * 1000);
    attemptsUsed = i + 1;
    let s: HealthGateSample;
    try {
      s = await sample();
    } catch (e) {
      lastReason = `sample error: ${(e as Error).message}`;
      consecutive = 0;
      continue;
    }
    last = s;

    const fatal = s.pods.find(
      (p) => (p.waitingReason && FATAL_WAITING.has(p.waitingReason)) || p.terminatedReason === "OOMKilled",
    );
    if (fatal) return { attempts: attemptsUsed, ok: false, lastReason: fatal.waitingReason ?? "OOMKilled" };

    const maxRestarts = s.pods.reduce((m, p) => Math.max(m, p.maxRestarts), 0);
    if (baselineRestarts === null) baselineRestarts = maxRestarts;
    else if (maxRestarts - baselineRestarts >= 2) {
      return { attempts: attemptsUsed, ok: false, lastReason: `restartCount jumped (+${maxRestarts - baselineRestarts})` };
    }

    if (s.replicas > 0 && s.readyReplicas === s.replicas) {
      consecutive += 1;
      lastReason = `ready ${consecutive}/${gate.successThreshold}`;
      if (consecutive >= gate.successThreshold) return { attempts: attemptsUsed, ok: true, lastReason: "healthy" };
    } else {
      consecutive = 0;
      lastReason = `not ready (${s.readyReplicas}/${s.replicas})`;
    }
  }

  if (last && last.observedGeneration !== last.generation) {
    return { attempts: attemptsUsed, ok: false, lastReason: "observedGeneration mismatch (controller behind)" };
  }
  return { attempts: attemptsUsed, ok: false, lastReason: `gate timeout (${lastReason})` };
}
