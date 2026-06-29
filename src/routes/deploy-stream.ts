import type { Clock } from "../lib/clock.ts";
import type { State, DeploymentRow } from "../lib/state.ts";

export interface DeployEventFrame {
  event: "status" | "error" | "heartbeat" | "end";
  data: string;
}

const TERMINAL: readonly DeploymentRow["status"][] = ["done", "failed", "cancelled"];
const DEFAULT_POLL_MS = 500;
const HEARTBEAT_EVERY_TICKS = 30;

function rowSnapshot(row: DeploymentRow): string {
  return JSON.stringify({
    id: row.id,
    service: row.service,
    tag: row.tag,
    status: row.status,
    message: row.message,
    action: row.action,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    healthGate: row.health_gate_result,
  });
}

function dedupeKey(row: DeploymentRow): string {
  return `${row.status}|${row.message ?? ""}|${row.finished_at ?? ""}|${row.health_gate_result ?? ""}`;
}

/**
 * Poll the deployments row at `pollMs`, yielding one `status` frame per observed change. Yields a
 * terminal `end` frame on done/failed/cancelled, or an `error` + `end` if the row vanishes. Honors
 * `signal` to stop promptly when the client disconnects.
 */
export async function* deployEvents(
  state: State,
  id: number,
  clock: Clock,
  signal: AbortSignal,
  pollMs: number = DEFAULT_POLL_MS,
): AsyncGenerator<DeployEventFrame> {
  let lastKey: string | null = null;
  let ticksSinceFrame = 0;
  while (!signal.aborted) {
    const row = state.deploymentById(id);
    if (!row) {
      yield { event: "error", data: JSON.stringify({ error: "deployment not found", id }) };
      yield { event: "end", data: "not_found" };
      return;
    }
    const key = dedupeKey(row);
    if (key !== lastKey) {
      yield { event: "status", data: rowSnapshot(row) };
      lastKey = key;
      ticksSinceFrame = 0;
    } else if (++ticksSinceFrame >= HEARTBEAT_EVERY_TICKS) {
      yield { event: "heartbeat", data: "" };
      ticksSinceFrame = 0;
    }
    if (TERMINAL.includes(row.status)) {
      yield { event: "end", data: row.status };
      return;
    }
    if (!(await wait(clock, pollMs, signal))) return;
  }
}

function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const onAbort = () => {
      if (resolved) return;
      resolved = true;
      clock.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const timer = clock.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
