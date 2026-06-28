import { describe, it, expect } from "bun:test";
import { fakeClock, realClock, type Timer } from "./clock.ts";

describe("fakeClock", () => {
  it("advances on tick", () => {
    const c = fakeClock(1000);
    expect(c.now()).toBe(1000);
    c.advance(1000);
    expect(c.now()).toBe(2000);
  });

  it("fires timers once when their deadline passes", () => {
    const c = fakeClock(0);
    let ran = 0;
    c.setTimeout(() => ran++, 100);
    c.advance(99);
    expect(ran).toBe(0);
    c.advance(1);
    expect(ran).toBe(1);
    c.advance(1000);
    expect(ran).toBe(1); // not re-fired
  });

  it("fires timers in chronological order with now() set to each deadline", () => {
    const c = fakeClock(0);
    const seen: number[] = [];
    c.setTimeout(() => seen.push(c.now()), 200);
    c.setTimeout(() => seen.push(c.now()), 50);
    c.advance(500);
    expect(seen).toEqual([50, 200]);
    expect(c.now()).toBe(500);
  });

  it("clearTimeout cancels a pending timer", () => {
    const c = fakeClock(0);
    let ran = 0;
    const t = c.setTimeout(() => ran++, 50);
    c.clearTimeout(t);
    c.advance(100);
    expect(ran).toBe(0);
  });

  it("runs a timer scheduled by another timer within the same advance window", () => {
    const c = fakeClock(0);
    const seen: number[] = [];
    c.setTimeout(() => {
      seen.push(c.now());
      c.setTimeout(() => seen.push(c.now()), 50); // re-schedule from within a callback
    }, 100);
    c.advance(200);
    expect(seen).toEqual([100, 150]);
    expect(c.now()).toBe(200);
  });

  it("a firing callback can cancel a still-pending timer", () => {
    const c = fakeClock(0);
    let ranLater = 0;
    let later: Timer = 0;
    c.setTimeout(() => c.clearTimeout(later), 50);
    later = c.setTimeout(() => ranLater++, 100);
    c.advance(200);
    expect(ranLater).toBe(0);
  });

  it("fires same-deadline timers in insertion order", () => {
    const c = fakeClock(0);
    const seen: string[] = [];
    c.setTimeout(() => seen.push("a"), 100);
    c.setTimeout(() => seen.push("b"), 100);
    c.advance(100);
    expect(seen).toEqual(["a", "b"]);
  });

  it("tracks the pending timer count", () => {
    const c = fakeClock(0);
    expect(c.pending).toBe(0);
    c.setTimeout(() => {}, 100);
    c.setTimeout(() => {}, 200);
    expect(c.pending).toBe(2);
    c.advance(150);
    expect(c.pending).toBe(1);
  });
});

describe("realClock", () => {
  it("proxies Date.now", () => {
    const before = Date.now();
    const n = realClock().now();
    const after = Date.now();
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(after);
  });

  it("schedules a real timer", async () => {
    const c = realClock();
    let ran = false;
    await new Promise<void>((resolve) => c.setTimeout(() => ((ran = true), resolve()), 1));
    expect(ran).toBe(true);
  });
});
