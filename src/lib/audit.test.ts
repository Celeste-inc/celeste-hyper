import { describe, it, expect } from "bun:test";
import { State } from "./state.ts";
import { fakeClock } from "./clock.ts";
import { recordAudit, queryAudit, pruneAudit, type AuditEvent } from "./audit.ts";

function setup() {
  const clock = fakeClock(1_000_000);
  const state = new State(":memory:", clock);
  return { clock, state };
}

const ev = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  actor: "alice",
  role: "admin",
  action: "deploy",
  resourceKind: "service",
  resourceId: "hello",
  result: "ok",
  ...over,
});

describe("recordAudit", () => {
  it("writes a row carrying the actor, role, and resource", () => {
    const { state, clock } = setup();
    recordAudit(state, ev({ message: "to v2" }), clock.now());
    const page = queryAudit(state, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ actor: "alice", role: "admin", action: "deploy", resource_id: "hello", result: "ok", message: "to v2" });
  });

  it("attributes worker steps to system", () => {
    const { state, clock } = setup();
    recordAudit(state, ev({ actor: "system", role: null, action: "job:done" }), clock.now());
    expect(queryAudit(state, { actor: "system" }).items[0]!.action).toBe("job:done");
  });

  it("is written when the enclosing transaction commits", () => {
    const { state, clock } = setup();
    state.transaction(() => recordAudit(state, ev(), clock.now()));
    expect(queryAudit(state, {}).items).toHaveLength(1);
  });

  it("is NOT written when the enclosing transaction rolls back", () => {
    const { state, clock } = setup();
    expect(() =>
      state.transaction(() => {
        recordAudit(state, ev(), clock.now());
        throw new Error("mutation failed after the audit insert");
      }),
    ).toThrow("mutation failed");
    expect(queryAudit(state, {}).items).toHaveLength(0); // rolled back with the action
  });

  it("pruneAudit retains only the most recent rows (bounded growth)", () => {
    const { state, clock } = setup();
    for (let i = 0; i < 10; i++) recordAudit(state, ev(), clock.now());
    pruneAudit(state, 4);
    const items = queryAudit(state, {}).items;
    expect(items).toHaveLength(4);
    expect(items.map((r) => r.id).sort((a, b) => a - b)).toEqual([7, 8, 9, 10]); // newest 4 kept
  });

  it("serializes the payload as JSON and omits request bodies by contract", () => {
    const { state, clock } = setup();
    recordAudit(state, ev({ payload: { tag: "v2", mode: "rolling" } }), clock.now());
    expect(JSON.parse(queryAudit(state, {}).items[0]!.payload!)).toEqual({ tag: "v2", mode: "rolling" });
  });
});

describe("queryAudit", () => {
  function seed(n: number) {
    const { state, clock } = setup();
    for (let i = 0; i < n; i++) {
      clock.advance(1000); // distinct timestamps
      recordAudit(state, ev({ action: i % 2 === 0 ? "deploy" : "rollback", result: i % 3 === 0 ? "fail" : "ok" }), clock.now());
    }
    return { state, clock };
  }

  it("returns newest first", () => {
    const { state } = seed(3);
    const items = queryAudit(state, {}).items;
    expect(items[0]!.id).toBeGreaterThan(items[1]!.id);
  });

  it("paginates with a stable keyset cursor (no overlap, no gaps)", () => {
    const { state } = seed(10);
    const first = queryAudit(state, { pageSize: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const second = queryAudit(state, { pageSize: 4, cursor: first.nextCursor! });
    const ids = new Set(first.items.map((r) => r.id));
    for (const r of second.items) expect(ids.has(r.id)).toBe(false); // no overlap
    // walking to the end yields exactly 10 distinct rows
    const seen = new Set<number>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page: ReturnType<typeof queryAudit> = queryAudit(state, { pageSize: 3, cursor: cursor ?? undefined });
      page.items.forEach((r) => seen.add(r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(10);
  });

  it("filters by result and action", () => {
    const { state } = seed(9);
    expect(queryAudit(state, { result: "fail" }).items.every((r) => r.result === "fail")).toBe(true);
    expect(queryAudit(state, { action: "deploy" }).items.every((r) => r.action === "deploy")).toBe(true);
  });

  it("filters by since/until on ts", () => {
    const { state } = setup();
    const c = fakeClock(0);
    recordAudit(state, ev(), 1000);
    recordAudit(state, ev(), 5000);
    recordAudit(state, ev(), 9000);
    void c;
    const mid = new Date(5000).toISOString();
    const end = new Date(9000).toISOString();
    expect(queryAudit(state, { since: mid }).items).toHaveLength(2); // 5000 and 9000
    expect(queryAudit(state, { until: end }).items).toHaveLength(2); // 1000 and 5000 (9000 excluded)
  });
});
