import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations.ts";
import { MIGRATIONS, BINARY_SCHEMA_VERSION } from "./migrations/index.ts";
import { fakeClock } from "./clock.ts";
import { acquireLock, releaseLock, fencedSetCurrent } from "./lock.ts";

function migratedDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  applyMigrations(db, MIGRATIONS, BINARY_SCHEMA_VERSION, { now: () => 0 });
  return db;
}

describe("acquireLock / releaseLock", () => {
  it("first call wins and returns a token", () => {
    const db = migratedDb();
    const a = acquireLock(db, "service:hello", "A", 5000, fakeClock(1000));
    expect(a).not.toBeNull();
    expect(a!.token).toBe(1);
    db.close();
  });

  it("blocks a different holder while held", () => {
    const db = migratedDb();
    const clock = fakeClock(1000);
    acquireLock(db, "service:hello", "A", 5000, clock);
    const b = acquireLock(db, "service:hello", "B", 5000, clock);
    expect(b).toBeNull();
    db.close();
  });

  it("release frees the lock for another holder with a higher token", () => {
    const db = migratedDb();
    const clock = fakeClock(1000);
    acquireLock(db, "service:hello", "A", 5000, clock);
    releaseLock(db, "service:hello", "A");
    const b = acquireLock(db, "service:hello", "B", 5000, clock);
    expect(b).not.toBeNull();
    expect(b!.token).toBe(2);
    db.close();
  });

  it("reclaims an expired lock with a strictly higher token", () => {
    const db = migratedDb();
    const clock = fakeClock(1000);
    const a = acquireLock(db, "service:hello", "A", 5000, clock);
    clock.advance(5001); // past TTL
    const b = acquireLock(db, "service:hello", "B", 5000, clock);
    expect(b).not.toBeNull();
    expect(b!.token).toBeGreaterThan(a!.token);
    db.close();
  });

  it("ignores a release from a non-holder", () => {
    const db = migratedDb();
    const clock = fakeClock(1000);
    acquireLock(db, "service:hello", "A", 5000, clock);
    releaseLock(db, "service:hello", "B"); // wrong holder — must be a no-op
    expect(acquireLock(db, "service:hello", "C", 5000, clock)).toBeNull(); // still held by A
    db.close();
  });

  it("keeps token sequences independent per resource", () => {
    const db = migratedDb();
    const clock = fakeClock(1000);
    expect(acquireLock(db, "service:a", "A", 5000, clock)!.token).toBe(1);
    expect(acquireLock(db, "service:b", "A", 5000, clock)!.token).toBe(1);
    releaseLock(db, "service:a", "A");
    expect(acquireLock(db, "service:a", "A2", 5000, clock)!.token).toBe(2);
    expect(acquireLock(db, "service:b", "A2", 5000, clock)).toBeNull(); // b still held
    db.close();
  });
});

describe("fencedSetCurrent", () => {
  it("rejects a strictly lower token, re-applies an equal one, and accepts a higher one", () => {
    const db = migratedDb();
    const clock = fakeClock(1000);

    expect(fencedSetCurrent(db, "hello", "v1", 5, clock)).toBe(true);

    // stale (lower) token → no-op
    expect(fencedSetCurrent(db, "hello", "v-stale", 3, clock)).toBe(false);
    let row = db.query("SELECT tag, token FROM current_deployment WHERE service='hello'").get() as {
      tag: string;
      token: number;
    };
    expect(row.tag).toBe("v1");
    expect(row.token).toBe(5);

    // equal token → idempotent re-apply (retry-safe; gate is current_token <= :token)
    expect(fencedSetCurrent(db, "hello", "v1", 5, clock)).toBe(true);

    // higher token → applied
    expect(fencedSetCurrent(db, "hello", "v2", 6, clock)).toBe(true);
    row = db.query("SELECT tag, token FROM current_deployment WHERE service='hello'").get() as {
      tag: string;
      token: number;
    };
    expect(row.tag).toBe("v2");
    expect(row.token).toBe(6);

    // a token below the new current is still rejected
    expect(fencedSetCurrent(db, "hello", "v-old", 5, clock)).toBe(false);
    db.close();
  });
});
