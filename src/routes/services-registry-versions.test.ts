import { describe, it, expect, mock, afterAll } from "bun:test";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

// Replace the OCI tag listing (network) before the route module loads it.
mock.module("../lib/registry.ts", () => ({
  listRegistryTags: async () => ({ tags: ["v1.11.0", "v1.10.4"], rateLimited: false, authRequired: false }),
  sortTagsDesc: (tags: string[]) => tags,
}));

const { buildApp } = await import("./_app.ts");

afterAll(() => mock.restore()); // don't leak the mock into other test files

describe("registry-pull versions", () => {
  it("GET /api/services/:name/versions registry-pull → items + source: registry", async () => {
    const deps = makeFakeDeps();
    seedCluster(deps);
    seedRegistryService(deps); // registry-pull "hello"
    const r = await call(buildApp(deps), "GET", "/api/services/hello/versions");
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("registry");
    expect(r.body.items).toEqual([{ tag: "v1.11.0" }, { tag: "v1.10.4" }]);
    expect(r.body.total).toBe(2);
    expect(r.body.rateLimited).toBe(false);
    expect(r.body.authRequired).toBe(false);
    expect(r.body.hint).toBeNull();
  });
});
