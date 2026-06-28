import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../lib/state.ts";
import { realClock } from "../lib/clock.ts";
import { applyMigrations } from "../lib/migrations.ts";
import { MIGRATIONS, BINARY_SCHEMA_VERSION } from "../lib/migrations/index.ts";
import { backup, restore, migrate, readLock, lockPathFor, acquireProcessLock } from "./state.ts";

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "hyper-cli-"));
  const dbPath = join(dir, "state.sqlite");
  new State(dbPath, realClock()).close(); // migrate a real DB to current
  return dbPath;
}

const alive = () => true;
const dead = () => false;

describe("readLock", () => {
  it("reports unlocked when no file, locked for a live pid, stale for a dead pid", () => {
    const dbPath = freshDb();
    const lp = lockPathFor(dbPath);
    expect(readLock(lp)).toMatchObject({ locked: false, pid: null });
    writeFileSync(lp, "4242");
    expect(readLock(lp, alive)).toMatchObject({ locked: true, pid: 4242, stale: false });
    expect(readLock(lp, dead)).toMatchObject({ locked: false, pid: 4242, stale: true });
  });
});

describe("acquireProcessLock", () => {
  it("exclusively creates the lock, refuses a live holder, and takes over a stale one", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyper-lock-"));
    const lp = join(dir, "state.sqlite.lock");
    expect(acquireProcessLock(lp)).toBe(true); // fresh
    expect(readFileSync(lp, "utf8")).toBe(String(process.pid));
    // a live holder (our own pid) → a second acquire refuses
    expect(acquireProcessLock(lp)).toBe(false);
    // a stale holder (dead pid) → taken over (so a crash doesn't brick restart)
    writeFileSync(lp, "999999");
    expect(acquireProcessLock(lp)).toBe(true);
    expect(readFileSync(lp, "utf8")).toBe(String(process.pid));
  });
});

describe("state backup", () => {
  it("refuses when a live lock file is present", () => {
    const dbPath = freshDb();
    writeFileSync(lockPathFor(dbPath), String(process.pid));
    const res = backup({ dbPath, out: `${dbPath}.bak`, isAlive: alive });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("live process");
    expect(existsSync(`${dbPath}.bak`)).toBe(false);
  });

  it("succeeds on a cold DB and the backup is a valid, migrated database", () => {
    const dbPath = freshDb();
    const out = `${dbPath}.bak`;
    const res = backup({ dbPath, out });
    expect(res.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    // the backup opens and already carries the schema
    const db = new Database(out, { readonly: true });
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='services'").all() as unknown[]).length;
    db.close();
    expect(tables).toBe(1);
  });

  it("refuses (cleanly, no throw) when --out already exists", () => {
    const dbPath = freshDb();
    const out = `${dbPath}.bak`;
    writeFileSync(out, "occupied");
    const res = backup({ dbPath, out });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("already exists");
  });

  it("proceeds with --force when the lock is stale (pid gone)", () => {
    const dbPath = freshDb();
    writeFileSync(lockPathFor(dbPath), "999999");
    const res = backup({ dbPath, out: `${dbPath}.bak`, force: true, isAlive: dead });
    expect(res.ok).toBe(true);
  });
});

describe("state restore", () => {
  it("validates the source through migrations before swapping it into place", () => {
    // a source DB that is BEHIND (only the bootstrap migration applied)
    const srcDir = mkdtempSync(join(tmpdir(), "hyper-src-"));
    const src = join(srcDir, "old.sqlite");
    const sdb = new Database(src);
    applyMigrations(sdb, MIGRATIONS.slice(0, 1), 1, { dbPath: src }); // only 0001-bootstrap
    sdb.close();

    const targetDir = mkdtempSync(join(tmpdir(), "hyper-tgt-"));
    const dbPath = join(targetDir, "state.sqlite");
    const res = restore({ from: src, dbPath });
    expect(res.ok).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    // restored DB was migrated all the way up
    const db = new Database(dbPath, { readonly: true });
    const versions = (db.query("SELECT version FROM schema_versions").all() as Array<{ version: string }>).map((r) => r.version);
    db.close();
    expect(versions).toContain("0001-bootstrap");
    expect(versions.length).toBe(MIGRATIONS.length); // brought fully up to date
    // validation must not litter the data dir with .bak files or the temp
    expect(readdirSync(dirname(dbPath)).filter((f) => f.includes(".bak") || f.includes(".restore.tmp"))).toEqual([]);
  });

  it("refuses a source DB that fails migration validation (and does not overwrite the target)", () => {
    const srcDir = mkdtempSync(join(tmpdir(), "hyper-bad-"));
    const src = join(srcDir, "future.sqlite");
    // a DB claiming a future schema version → downgrade protection rejects it
    const sdb = new Database(src);
    new State(src, realClock()).close();
    const sdb2 = new Database(src);
    sdb2.run("INSERT INTO schema_versions VALUES ('0099-future', 't', 'x')");
    sdb2.close();
    void sdb;

    const targetDir = mkdtempSync(join(tmpdir(), "hyper-tgt2-"));
    const dbPath = join(targetDir, "state.sqlite");
    const res = restore({ from: src, dbPath });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("migration validation");
    expect(existsSync(dbPath)).toBe(false); // target untouched
  });

  it("refuses when a live lock is present", () => {
    const dbPath = freshDb();
    writeFileSync(lockPathFor(dbPath), String(process.pid));
    const res = restore({ from: dbPath, dbPath, isAlive: alive });
    expect(res.ok).toBe(false);
  });
});

describe("state migrate", () => {
  it("is idempotent — a second run applies nothing", () => {
    const dbPath = freshDb();
    expect(migrate({ dbPath }).message).toContain("up to date"); // freshDb already migrated
    expect(migrate({ dbPath }).message).toContain("up to date");
  });

  it("brings a behind DB up to date", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyper-mig-"));
    const dbPath = join(dir, "state.sqlite");
    const db = new Database(dbPath);
    applyMigrations(db, MIGRATIONS.slice(0, 1), 1, { dbPath });
    db.close();
    const res = migrate({ dbPath });
    expect(res.ok).toBe(true);
    expect(res.message).toContain(`applied ${MIGRATIONS.length - 1}`);
  });
});

describe("readFileSync sanity", () => {
  it("the lock file carries the writing pid", () => {
    const dbPath = freshDb();
    writeFileSync(lockPathFor(dbPath), "123");
    expect(readFileSync(lockPathFor(dbPath), "utf8")).toBe("123");
  });
});
