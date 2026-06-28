import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "./test-helpers.ts";

let dirs: string[] = [];
function envDir(): string {
  const d = mkdtempSync(join(tmpdir(), "celeste-envtest-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function appWith() {
  const deps = makeFakeDeps({ envFilesDir: envDir() });
  seedCluster(deps);
  seedRegistryService(deps);
  return buildApp(deps);
}

describe("env routes", () => {
  it("GET /api/services/:name/env/config → 200 with summary", async () => {
    const r = await call(appWith(), "GET", "/api/services/hello/env/config");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("path");
    expect(r.body).toHaveProperty("exists");
    expect(Array.isArray(r.body.keys)).toBe(true);
  });

  it("PUT /api/services/:name/env/config → 200 { ok: true } and round-trips keys", async () => {
    const app = appWith();
    const put = await call(app, "PUT", "/api/services/hello/env/config", { content: "LOG_LEVEL=debug\nPORT=8080\n" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });
    const get = await call(app, "GET", "/api/services/hello/env/config");
    expect(get.body.exists).toBe(true);
    expect(get.body.keys).toEqual(["LOG_LEVEL", "PORT"]);
  });

  it("GET config?reveal=true returns the content", async () => {
    const app = appWith();
    await call(app, "PUT", "/api/services/hello/env/config", { content: "LOG_LEVEL=debug\n" });
    const r = await call(app, "GET", "/api/services/hello/env/config?reveal=true");
    expect(r.status).toBe(200);
    expect(r.body.content).toBe("LOG_LEVEL=debug\n");
  });

  it("GET secret?reveal=true never returns the secret value", async () => {
    const app = appWith();
    await call(app, "PUT", "/api/services/hello/env/secret", { content: "API_KEY=supersecret\n" });
    const r = await call(app, "GET", "/api/services/hello/env/secret?reveal=true");
    expect(r.status).toBe(200);
    expect(r.body.content).toBeUndefined();
    expect(r.text).not.toContain("supersecret"); // value must never cross the wire
    expect(r.body.keys).toEqual(["API_KEY"]); // keys are fine to surface
  });

  it("GET /api/services/:name/env/badkind → 400", async () => {
    const r = await call(appWith(), "GET", "/api/services/hello/env/badkind");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("config|secret");
  });

  it("PUT /api/services/:name/env/config invalid body → 422", async () => {
    const r = await call(appWith(), "PUT", "/api/services/hello/env/config", { notcontent: 1 });
    expect(r.status).toBe(422);
  });

  it("GET env for unknown service → 404", async () => {
    const r = await call(buildApp(makeFakeDeps()), "GET", "/api/services/ghost/env/config");
    expect(r.status).toBe(404);
  });

  it("PUT /env/:kind/rows persists rows; GET returns the same keys + descriptions", async () => {
    const app = appWith();
    const put = await call(app, "PUT", "/api/services/hello/env/config/rows", {
      rows: [
        { key: "DB_URL", value: "postgres://x", description: "primary db" },
        { key: "LOG_LEVEL", value: "debug" },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    const get = await call(app, "GET", "/api/services/hello/env/config");
    expect(get.body.keys).toEqual(["DB_URL", "LOG_LEVEL"]);
    expect(get.body.rows).toEqual([{ key: "DB_URL", description: "primary db" }, { key: "LOG_LEVEL" }]);
    const reveal = await call(app, "GET", "/api/services/hello/env/config?reveal=true");
    expect(reveal.body.content).toBe("# primary db\nDB_URL=postgres://x\nLOG_LEVEL=debug\n");
  });

  it("PUT /env/:kind/rows with duplicate keys → 422", async () => {
    const r = await call(appWith(), "PUT", "/api/services/hello/env/config/rows", {
      rows: [{ key: "A", value: "1" }, { key: "A", value: "2" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.issues).toContain("duplicate key: A");
  });

  it("PUT /env/:kind/rows reports stripped control characters", async () => {
    const r = await call(appWith(), "PUT", "/api/services/hello/env/config/rows", {
      rows: [{ key: "X", value: "a\bb" }],
    });
    expect(r.status).toBe(200);
    expect(r.body.stripped).toEqual(["X"]);
  });

  it("secret rows never include values in the GET summary", async () => {
    const app = appWith();
    await call(app, "PUT", "/api/services/hello/env/secret/rows", { rows: [{ key: "API_KEY", value: "supersecret" }] });
    const r = await call(app, "GET", "/api/services/hello/env/secret");
    expect(r.text).not.toContain("supersecret");
    expect(r.body.rows).toEqual([{ key: "API_KEY" }]);
  });

  it("a blank secret value preserves the stored secret (no data loss)", async () => {
    const dir = envDir();
    const deps = makeFakeDeps({ envFilesDir: dir });
    seedCluster(deps);
    seedRegistryService(deps);
    const app = buildApp(deps);
    await call(app, "PUT", "/api/services/hello/env/secret/rows", { rows: [{ key: "API_KEY", value: "supersecret" }] });
    // re-save with a blank value (operator didn't re-type it) + a new key
    await call(app, "PUT", "/api/services/hello/env/secret/rows", {
      rows: [{ key: "API_KEY", value: "" }, { key: "NEW", value: "fresh" }],
    });
    const onDisk = readFileSync(join(dir, "hello", "secret.env"), "utf8");
    expect(onDisk).toContain("API_KEY=supersecret"); // stored secret preserved despite blank input
    expect(onDisk).toContain("NEW=fresh");
  });

  it("legacy PUT /env/:kind (raw content) still works", async () => {
    const app = appWith();
    const r = await call(app, "PUT", "/api/services/hello/env/config", { content: "A=1\n" });
    expect(r.status).toBe(200);
    expect((await call(app, "GET", "/api/services/hello/env/config")).body.keys).toEqual(["A"]);
  });
});
