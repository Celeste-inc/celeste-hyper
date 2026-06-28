import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call } from "./test-helpers.ts";
import { UI_ASSETS } from "../generated/ui-assets.ts";

const jsKey = Object.keys(UI_ASSETS).find((k) => k.startsWith("/assets/") && k.endsWith(".js"));

describe("static assets", () => {
  it("GET / → 200 text/html charset utf-8", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")?.toLowerCase()).toContain("text/html");
    expect(r.headers.get("content-type")?.toLowerCase()).toContain("utf-8");
  });

  it("GET /index.html → 200", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/index.html");
    expect(r.status).toBe(200);
  });

  it("GET /assets/<known>.js → 200 with immutable cache header", async () => {
    expect(jsKey).toBeDefined();
    const r = await call(buildApp(makeFakeDeps()), "GET", jsKey!);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("immutable");
  });

  it("GET /assets/<unknown>.js → 404 (no SPA fallback for /assets/)", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/assets/does-not-exist.js");
    expect(r.status).toBe(404);
  });

  it("GET /some/spa/route → 200 with index.html body (SPA fallback)", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/services/foo");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")?.toLowerCase()).toContain("text/html");
  });
});
