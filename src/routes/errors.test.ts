import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call } from "./test-helpers.ts";

describe("error handling", () => {
  it("unknown /api route → 404 with { error: 'not found' }", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/api/this-route-does-not-exist");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "not found" });
  });

  it("validation error → 422 with { error, issues }", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/clusters", {});
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("invalid body");
    expect(Array.isArray(r.body.issues)).toBe(true);
  });

  it("unhandled exception → 500 with { error: 'internal error' } (no stack leak)", async () => {
    const deps = makeFakeDeps({ pollerThrows: true });
    const r = await call(buildApp(deps), "GET", "/api/system");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "internal error" });
    expect(r.text).not.toContain("poller boom");
  });
});
