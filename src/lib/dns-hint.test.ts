import { describe, it, expect } from "bun:test";
import { fakeClock } from "./clock.ts";
import { makeDnsResolver } from "./dns-hint.ts";

describe("makeDnsResolver", () => {
  it("resolves a host to addresses with an elapsed time", async () => {
    const clock = fakeClock(0);
    const resolve = makeDnsResolver({ clock, lookupFn: async () => [{ address: "1.2.3.4" }, { address: "5.6.7.8" }] });
    const hint = await resolve("svc.example.com");
    expect(hint).toEqual({ resolved: true, addresses: ["1.2.3.4", "5.6.7.8"], elapsedMs: 0 });
  });

  it("reports a timeout when the lookup exceeds the budget", async () => {
    const clock = fakeClock(0);
    const resolve = makeDnsResolver({ clock, timeoutMs: 200, lookupFn: () => new Promise(() => {}) });
    const pending = resolve("slow.example.com");
    clock.advance(200);
    expect(await pending).toEqual({ resolved: false, reason: "timeout after 200ms" });
  });

  it("reports the error reason when the lookup fails", async () => {
    const clock = fakeClock(0);
    const resolve = makeDnsResolver({ clock, lookupFn: async () => { throw new Error("ENOTFOUND"); } });
    expect(await resolve("nope.example.com")).toEqual({ resolved: false, reason: "ENOTFOUND" });
  });

  it("caches within the TTL (does not re-lookup)", async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const resolve = makeDnsResolver({ clock, cacheTtlMs: 60_000, lookupFn: async () => { calls++; return [{ address: "1.1.1.1" }]; } });
    await resolve("host");
    await resolve("host");
    expect(calls).toBe(1);
    clock.advance(60_001);
    await resolve("host");
    expect(calls).toBe(2);
  });

  it("returns 'no host' for an empty host", async () => {
    const resolve = makeDnsResolver({ clock: fakeClock(0) });
    expect(await resolve("")).toEqual({ resolved: false, reason: "no host" });
  });
});
