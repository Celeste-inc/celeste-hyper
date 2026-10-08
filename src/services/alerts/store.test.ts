import { describe, expect, it } from "bun:test";
import { State } from "../../lib/state.ts";
import { fakeClock } from "../../lib/clock.ts";
import type { AlertRecord } from "./types.ts";

const record = (over: Partial<AlertRecord> = {}): AlertRecord => ({
  key: "k1",
  severity: "critical",
  category: "pod-crashloop",
  service: "sollo-api",
  title: "Container em CrashLoopBackOff",
  scope: "local/sollo-prod",
  firstSeen: "2026-10-07T20:00:00.000Z",
  lastSeen: "2026-10-07T20:00:00.000Z",
  lastSent: null,
  suppressed: 0,
  total: 1,
  open: true,
  condition: true,
  ...over,
});

describe("State alert store", () => {
  it("round-trips alert records, lists open conditions and prunes closed history", () => {
    const state = new State(":memory:", fakeClock(Date.parse("2026-10-07T20:00:00Z")));
    state.saveAlert(record());
    state.saveAlert(record({ key: "k2", condition: false, category: "app-error", lastSeen: "2026-09-01T00:00:00.000Z" }));
    expect(state.getAlert("k1")).toEqual(record());
    state.saveAlert(record({ lastSent: "2026-10-07T20:01:00.000Z", suppressed: 3, total: 4 }));
    expect(state.getAlert("k1")).toMatchObject({ lastSent: "2026-10-07T20:01:00.000Z", suppressed: 3, total: 4 });
    expect(state.openConditions().map((r) => r.key)).toEqual(["k1"]);
    expect(state.pruneAlerts("2026-10-01T00:00:00.000Z")).toBe(1);
    expect(state.getAlert("k2")).toBeNull();
  });

  it("stores cursors", () => {
    const state = new State(":memory:", fakeClock(0));
    expect(state.getCursor("logs:x")).toBeNull();
    state.setCursor("logs:x", "2026-10-07T20:00:01.000000000Z");
    state.setCursor("logs:x", "2026-10-07T20:00:02.000000000Z");
    expect(state.getCursor("logs:x")).toBe("2026-10-07T20:00:02.000000000Z");
  });
});
