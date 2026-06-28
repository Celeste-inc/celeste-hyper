import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync, rmSync, copyFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS, BINARY_SCHEMA_VERSION } from "../lib/migrations/index.ts";
import { applyMigrations } from "../lib/migrations.ts";

/** The PID-stamped lock file that marks a live process holding the DB. */
export function lockPathFor(dbPath: string): string {
  return `${dbPath}.lock`;
}

export interface LockState {
  locked: boolean; // a live process holds the DB
  pid: number | null;
  stale: boolean; // a lock file exists but its process is gone
}

/** True if `pid` is a live process. `EPERM` (exists, not ours) still counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the lock file and decide whether a live process holds the DB. `isAlive` injected for tests. */
export function readLock(lockPath: string, isAlive: (pid: number) => boolean = pidAlive): LockState {
  if (!existsSync(lockPath)) return { locked: false, pid: null, stale: false };
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return { locked: false, pid: null, stale: true };
  const alive = isAlive(pid);
  return { locked: alive, pid, stale: !alive };
}

/**
 * Acquire the PID lock at startup with an exclusive create (so two simultaneous boots can't both
 * win the TOCTOU). Returns false if a *live* process already holds it; takes over a stale lock
 * (dead pid). A tiny residual race on the stale-takeover path is acceptable for an operator tool.
 */
export function acquireProcessLock(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (readLock(lockPath).locked) return false; // a live process holds it
    writeFileSync(lockPath, String(process.pid)); // stale → take it over
    return true;
  }
}

/** Remove the PID lock on graceful shutdown (best effort). */
export function releaseProcessLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // a missing lock on shutdown is fine
  }
}

export interface CmdResult {
  ok: boolean;
  message: string;
}

export interface OfflineOpts {
  dbPath: string;
  force?: boolean;
  isAlive?: (pid: number) => boolean;
}

function guardCold(dbPath: string, force: boolean | undefined, isAlive?: (pid: number) => boolean): CmdResult | null {
  const lock = readLock(lockPathFor(dbPath), isAlive);
  if (lock.locked && !force) {
    return { ok: false, message: `refusing: a live process (pid ${lock.pid}) holds ${dbPath}. Stop it first, or pass --force only if that pid is gone.` };
  }
  return null;
}

/** `state backup --out` — `VACUUM INTO` a cold DB into a clean single-file copy. */
export function backup(opts: OfflineOpts & { out: string }): CmdResult {
  const blocked = guardCold(opts.dbPath, opts.force, opts.isAlive);
  if (blocked) return blocked;
  if (!existsSync(opts.dbPath)) return { ok: false, message: `no database at ${opts.dbPath}` };
  if (!opts.out) return { ok: false, message: "missing --out=<path>" };
  if (existsSync(opts.out)) return { ok: false, message: `--out already exists: ${opts.out} (VACUUM INTO needs a fresh path)` };
  const db = new Database(opts.dbPath, { readonly: true });
  try {
    // VACUUM INTO writes a fresh, compacted, WAL-free copy. Single-quote-escape the (operator-supplied) path.
    db.exec(`VACUUM INTO '${opts.out.replace(/'/g, "''")}'`);
  } catch (e) {
    return { ok: false, message: `backup failed: ${(e as Error).message}` };
  } finally {
    db.close();
  }
  return { ok: true, message: `backed up ${opts.dbPath} → ${opts.out}` };
}

/** `state migrate` — apply pending migrations to the current DB. Idempotent. */
export function migrate(opts: { dbPath: string }): CmdResult {
  const db = new Database(opts.dbPath);
  try {
    const res = applyMigrations(db, MIGRATIONS, BINARY_SCHEMA_VERSION, { dbPath: opts.dbPath });
    return { ok: true, message: res.applied.length ? `applied ${res.applied.length}: ${res.applied.join(", ")}` : "already up to date" };
  } finally {
    db.close();
  }
}

/** `state restore --from` — validate the source migrates cleanly (on a temp copy), then swap it in. */
export function restore(opts: OfflineOpts & { from: string }): CmdResult {
  const blocked = guardCold(opts.dbPath, opts.force, opts.isAlive);
  if (blocked) return blocked;
  if (!existsSync(opts.from)) return { ok: false, message: `no source database at ${opts.from}` };

  const temp = `${opts.dbPath}.restore.tmp`;
  for (const ext of ["", "-wal", "-shm"]) rmSync(`${temp}${ext}`, { force: true });
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  copyFileSync(opts.from, temp);
  // Copy any WAL/SHM sidecars so a not-cleanly-closed source (crash) doesn't silently lose its
  // last committed transactions — SQLite recovers them from the -wal on the next open.
  for (const ext of ["-wal", "-shm"]) if (existsSync(`${opts.from}${ext}`)) copyFileSync(`${opts.from}${ext}`, `${temp}${ext}`);
  try {
    const db = new Database(temp);
    try {
      // dbPath ":memory:" suppresses the harness's pre-migration .bak files (they'd otherwise litter
      // the data dir as `<dbPath>.restore.tmp.bak.*`); migrations still apply to the real temp db.
      applyMigrations(db, MIGRATIONS, BINARY_SCHEMA_VERSION, { dbPath: ":memory:" });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // fold any WAL into the main temp file before the swap
    } finally {
      db.close();
    }
  } catch (e) {
    for (const ext of ["", "-wal", "-shm"]) rmSync(`${temp}${ext}`, { force: true });
    return { ok: false, message: `source database failed migration validation (not restored): ${(e as Error).message}` };
  }
  // Atomic swap (temp and dbPath share a filesystem): no half-written-target window on a crash. The
  // temp is now a single consolidated file; drop its + the OLD dbPath's stale WAL/SHM sidecars so the
  // next boot can't apply a leftover WAL to the new DB.
  for (const ext of ["-wal", "-shm"]) rmSync(`${temp}${ext}`, { force: true });
  renameSync(temp, opts.dbPath);
  for (const ext of ["-wal", "-shm"]) rmSync(`${opts.dbPath}${ext}`, { force: true });
  return { ok: true, message: `restored ${opts.from} → ${opts.dbPath} (migrated to schema v${BINARY_SCHEMA_VERSION})` };
}

export const ONLINE_ADVICE =
  "Online (hot) backup of a running process uses SQLite's backup API, which is consistent without stopping hyper:\n" +
  "  sqlite3 <stateDir>/state.sqlite \".backup '<stateDir>/state.sqlite.bak'\"\n" +
  "The offline `state backup` is for a stopped process and produces a compacted copy via VACUUM INTO.";
