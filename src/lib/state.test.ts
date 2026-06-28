import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "./state.ts";
import { MIGRATIONS } from "./migrations/index.ts";

let dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "celeste-state-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("State migration wiring", () => {
  it("creates the bootstrap schema on a fresh DB", () => {
    const p = join(tmpDir(), "state.sqlite");
    new State(p).close();

    const db = new Database(p);
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const t of ["clusters", "current_deployment", "deployments", "schema_versions", "services"]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it("re-opening is idempotent (single schema_versions row)", () => {
    const p = join(tmpDir(), "state.sqlite");
    new State(p).close();
    new State(p).close();

    const db = new Database(p);
    const n = (db.query("SELECT count(*) AS n FROM schema_versions").get() as { n: number }).n;
    expect(n).toBe(MIGRATIONS.length); // re-open applied nothing new
    db.close();
  });

  it("adopts a legacy pre-harness DB, preserves data, and snapshots it first", () => {
    const dir = tmpDir();
    const p = join(dir, "state.sqlite");

    const legacy = new Database(p);
    legacy.exec("PRAGMA journal_mode = WAL");
    legacy.exec(
      "CREATE TABLE services (name TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    legacy.run("INSERT INTO services VALUES ('svc-x', '{}', 't', 't')");
    legacy.close();

    new State(p).close();

    const db = new Database(p);
    const versions = (db.query("SELECT version FROM schema_versions").all() as Array<{ version: string }>).map(
      (r) => r.version,
    );
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    const kept = (db.query("SELECT name FROM services").all() as Array<{ name: string }>).map((r) => r.name);
    expect(kept).toEqual(["svc-x"]);
    db.close();

    // A populated legacy DB is backed up before its first harness-managed migration.
    const backups = readdirSync(dir).filter((f) => f.startsWith("state.sqlite.bak."));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });
});

describe("State users + meta", () => {
  it("creates, reads, and counts users; updates the password", () => {
    const s = new State(":memory:");
    expect(s.countUsers()).toBe(0);
    expect(s.getUser("alice")).toBeNull();

    s.createUser("alice", "hash1", "admin", true);
    expect(s.countUsers()).toBe(1);
    const u = s.getUser("alice");
    expect(u).not.toBeNull();
    expect(u!.role).toBe("admin");
    expect(u!.password_hash).toBe("hash1");
    expect(u!.must_change_password).toBe(1);

    expect(s.setUserPassword("alice", "hash2", false)).toBe(true);
    expect(s.getUser("alice")!.password_hash).toBe("hash2");
    expect(s.getUser("alice")!.must_change_password).toBe(0);
    expect(s.setUserPassword("ghost", "x")).toBe(false);
    s.close();
  });

  it("stores and overwrites meta key/values", () => {
    const s = new State(":memory:");
    expect(s.getMeta("jwt_secret")).toBeNull();
    s.setMeta("jwt_secret", "abc");
    expect(s.getMeta("jwt_secret")).toBe("abc");
    s.setMeta("jwt_secret", "def"); // upsert
    expect(s.getMeta("jwt_secret")).toBe("def");
    s.close();
  });
});
