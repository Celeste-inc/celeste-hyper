import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, MigrationError } from "./migrations.ts";

let root: string;
let migDir: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "celeste-mig-"));
  migDir = join(root, "migrations");
  mkdirSync(migDir);
  dbPath = join(root, "state.sqlite");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function write(name: string, sql: string): void {
  writeFileSync(join(migDir, name), sql);
}

function sha(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function openDb(): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

// Injectable monotonic clock so applied_at strictly increases in application order.
function incNow(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => {
    t += 1000;
    return t;
  };
}

function backupNames(): string[] {
  return readdirSync(root).filter((f) => f.startsWith("state.sqlite.bak."));
}

describe("applyMigrations", () => {
  it("applies migrations in order", () => {
    // written out of lexical order on purpose; harness must sort them.
    write("0002-b.sql", "CREATE TABLE b (id INTEGER);");
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    write("0003-c.sql", "CREATE TABLE c (id INTEGER);");

    const db = openDb();
    const res = applyMigrations(db, migDir, 3, { now: incNow() });
    expect(res.applied).toEqual(["0001-a", "0002-b", "0003-c"]);
    expect(res.currentVersion).toBe("0003-c");

    // rowid is natural insertion order — proves application order independent of timestamps.
    const rows = db
      .query("SELECT version, applied_at FROM schema_versions ORDER BY rowid")
      .all() as Array<{ version: string; applied_at: string }>;
    expect(rows.map((r) => r.version)).toEqual(["0001-a", "0002-b", "0003-c"]);
    for (const r of rows) expect(r.applied_at).toMatch(ISO);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.applied_at > rows[i - 1]!.applied_at).toBe(true);

    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b','c')").all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(["a", "b", "c"]);
    db.close();
  });

  it("is idempotent across restarts", () => {
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    write("0002-b.sql", "CREATE TABLE b (id INTEGER);");

    let db = openDb();
    applyMigrations(db, migDir, 2, { now: incNow() });
    db.close();

    // Restart with a brand new connection and a different clock; nothing should change.
    db = openDb();
    const before = db.query("SELECT version, applied_at, sha256 FROM schema_versions ORDER BY version").all();
    const backupsBefore = backupNames().length;
    const res = applyMigrations(db, migDir, 2, { now: incNow(2_000_000_000_000) });
    const after = db.query("SELECT version, applied_at, sha256 FROM schema_versions ORDER BY version").all();

    expect(res.applied).toEqual([]);
    expect(res.currentVersion).toBe("0002-b");
    expect(after).toEqual(before);
    expect((after as unknown[]).length).toBe(2);
    expect(backupNames().length).toBe(backupsBefore); // no-op re-run writes no new backup
    db.close();
  });

  it("rolls back a failing migration and does not promote the backup", () => {
    // Establish prior good state so a pre-migration backup is taken before the bad one.
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    let db = openDb();
    applyMigrations(db, migDir, 1, { now: incNow() });
    db.close();

    write("0002-bad.sql", "CREATE TABLE b (id INTEGER); THIS IS NOT VALID SQL;");
    db = openDb();

    let err: unknown;
    try {
      applyMigrations(db, migDir, 2, { now: incNow(2_000_000_000_000) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).code).toBe("MIGRATION_FAILED");
    expect((err as MigrationError).version).toBe("0002-bad");

    // The failing migration left no trace: table b absent, schema_versions still only 0001.
    const b = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='b'").all();
    expect((b as unknown[]).length).toBe(0);
    const versions = (db.query("SELECT version FROM schema_versions").all() as Array<{ version: string }>).map(
      (r) => r.version,
    );
    expect(versions).toEqual(["0001-a"]);

    // A backup was written before the attempt.
    expect(backupNames().some((f) => f.startsWith("state.sqlite.bak.0002-bad."))).toBe(true);

    // The harness performs no auto-restore: the live DB stays the rolled-back state and is
    // authoritative. A sentinel written now must persist across reopen.
    db.run("INSERT INTO a (id) VALUES (?)", [42]);
    db.close();
    const reopened = new Database(dbPath);
    const sentinel = reopened.query("SELECT id FROM a WHERE id = 42").get() as { id: number } | null;
    expect(sentinel?.id).toBe(42);
    reopened.close();
  });

  it("writes a pre-migration backup and prunes beyond 5 by numeric time", () => {
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    let db = openDb();
    applyMigrations(db, migDir, 1, { now: () => 1000 });
    db.close();

    // Seed backups whose NUMERIC order differs from LEXICAL order, to prove numeric pruning.
    // numeric desc: 1000, 100, 80, 9, 7  — but lexical desc would be "9","80","7","1000","100".
    for (const t of [9, 100, 80, 1000, 7]) {
      writeFileSync(join(root, `state.sqlite.bak.0001-a.${t}`), "old");
    }

    write("0002-b.sql", "CREATE TABLE b (id INTEGER);");
    db = openDb();
    applyMigrations(db, migDir, 2, { now: () => 5000 });
    db.close();

    // 6 candidates by unixtime {7,9,80,100,1000,5000} → keep newest 5 → drop 7.
    const suffixes = backupNames()
      .map((f) => Number(f.slice(f.lastIndexOf(".") + 1)))
      .sort((a, b) => a - b);
    expect(suffixes).toEqual([9, 80, 100, 1000, 5000]);
  });

  it("refuses downgrade", () => {
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    write("0002-b.sql", "CREATE TABLE b (id INTEGER);");
    let db = openDb();
    applyMigrations(db, migDir, 2, { now: incNow() }); // DB advanced to schema version 2
    db.close();

    db = openDb();
    const before = db.query("SELECT version FROM schema_versions ORDER BY version").all();
    let err: unknown;
    try {
      // binary only knows up to version 1, DB is at 2 → refuse
      applyMigrations(db, migDir, 1, { now: incNow() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).code).toBe("DOWNGRADE");
    // DB untouched by the refused run.
    expect(db.query("SELECT version FROM schema_versions ORDER BY version").all()).toEqual(before);
    db.close();
  });

  it("applies migrations from an embedded array (compiled-binary mode)", () => {
    const db = openDb();
    const res = applyMigrations(
      db,
      [
        { version: "0001-a", sql: "CREATE TABLE a (id INTEGER);" },
        { version: "0002-b", sql: "CREATE TABLE b (id INTEGER);" },
      ],
      2,
      { now: incNow() },
    );
    expect(res.applied).toEqual(["0001-a", "0002-b"]);
    expect(res.currentVersion).toBe("0002-b");
    const versions = (db.query("SELECT version FROM schema_versions ORDER BY version").all() as Array<{ version: string }>).map(
      (r) => r.version,
    );
    expect(versions).toEqual(["0001-a", "0002-b"]);
    db.close();
  });

  it("applies only the newly-pending migration on an incremental run", () => {
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    let db = openDb();
    const first = applyMigrations(db, migDir, 1, { now: incNow() });
    expect(first.applied).toEqual(["0001-a"]);
    db.close();

    write("0002-b.sql", "CREATE TABLE b (id INTEGER);");
    db = openDb();
    const second = applyMigrations(db, migDir, 2, { now: incNow(2_000_000_000_000) });
    expect(second.applied).toEqual(["0002-b"]);
    expect(second.currentVersion).toBe("0002-b");
    db.close();
  });

  it("throws if an already-applied migration's checksum changed", () => {
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    let db = openDb();
    applyMigrations(db, migDir, 1, { now: incNow() });
    db.close();

    // Tamper with a migration that was already recorded.
    write("0001-a.sql", "CREATE TABLE a (id INTEGER, extra TEXT);");
    db = openDb();
    const before = db.query("SELECT version, sha256 FROM schema_versions").all();
    let err: unknown;
    try {
      applyMigrations(db, migDir, 1, { now: incNow() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).code).toBe("MIGRATION_CHECKSUM_MISMATCH");
    expect((err as MigrationError).version).toBe("0001-a");
    expect(db.query("SELECT version, sha256 FROM schema_versions").all()).toEqual(before);
    db.close();
  });

  it("skips a migration a peer applied between snapshot and lock (concurrent boot)", () => {
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    const peerSha = sha(readFileSync(join(migDir, "0001-a.sql"), "utf8"));
    const db = openDb();

    const res = applyMigrations(db, migDir, 1, {
      now: () => 1,
      _afterSnapshot: () => {
        // Simulate a peer process that applied 0001-a after our snapshot was read.
        db.exec("CREATE TABLE a (id INTEGER);");
        db.run("INSERT INTO schema_versions (version, applied_at, sha256) VALUES (?, ?, ?)", [
          "0001-a",
          "1970-01-01T00:00:00.000Z",
          peerSha,
        ]);
      },
    });

    // We must NOT crash with MIGRATION_FAILED; we detect the peer applied it and skip.
    expect(res.applied).toEqual([]);
    expect(res.currentVersion).toBe("0001-a");
    const n = (db.query("SELECT count(*) AS n FROM schema_versions WHERE version='0001-a'").get() as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });

  it("rejects a peer that applied the same version with different content", () => {
    write("0001-a.sql", "CREATE TABLE a (id INTEGER);");
    const db = openDb();
    let err: unknown;
    try {
      applyMigrations(db, migDir, 1, {
        now: () => 1,
        _afterSnapshot: () => {
          db.run("INSERT INTO schema_versions (version, applied_at, sha256) VALUES (?, ?, ?)", [
            "0001-a",
            "1970-01-01T00:00:00.000Z",
            "a-different-checksum",
          ]);
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).code).toBe("MIGRATION_CHECKSUM_MISMATCH");
    db.close();
  });
});
