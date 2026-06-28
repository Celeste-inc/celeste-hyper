import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { log } from "./logger.ts";

export type MigrationErrorCode = "MIGRATION_FAILED" | "DOWNGRADE" | "MIGRATION_CHECKSUM_MISMATCH";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly version?: string;

  constructor(code: MigrationErrorCode, message: string, version?: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.version = version;
  }
}

export interface RawMigration {
  /** Lexically-sortable identity, e.g. `0001-bootstrap`. */
  version: string;
  /** One or more SQL statements applied inside a single transaction. */
  sql: string;
}

export interface MigrationOptions {
  /**
   * Wall-clock source in ms. Injected so tests are deterministic.
   * P0.2 replaces this with the shared `Clock` seam.
   */
  now?: () => number;
  /** Path of the on-disk SQLite file; defaults to `db.filename`. `:memory:` disables backups. */
  dbPath?: string;
  /** How many pre-migration backups to retain. */
  keepBackups?: number;
  /** @internal Test seam: invoked once after the applied-versions snapshot is read. */
  _afterSnapshot?: () => void;
}

export interface MigrationResult {
  /** Versions applied during this invocation, in order. */
  applied: string[];
  /** Highest version present after this invocation, or null if none. */
  currentVersion: string | null;
}

interface PreparedMigration extends RawMigration {
  sha256: string;
  numeric: number;
}

const DEFAULT_KEEP_BACKUPS = 5;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function numericVersion(version: string): number {
  const n = parseInt(version, 10);
  return Number.isNaN(n) ? 0 : n;
}

function loadFromDir(dir: string): RawMigration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ version: f.slice(0, -4), sql: readFileSync(join(dir, f), "utf8") }));
}

function prepare(source: string | RawMigration[]): PreparedMigration[] {
  const raw = typeof source === "string" ? loadFromDir(source) : source;
  return raw
    .map((m) => ({ version: m.version, sql: m.sql, sha256: sha256Hex(m.sql), numeric: numericVersion(m.version) }))
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

function countUserTables(db: Database): number {
  const r = db
    .query(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name <> 'schema_versions' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { n: number };
  return r.n;
}

function pruneBackups(dbPath: string, keep: number): void {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.bak.`;
  const entries = readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => {
      const suffix = f.slice(f.lastIndexOf(".") + 1);
      return { name: f, t: /^[0-9]+$/.test(suffix) ? Number(suffix) : null };
    })
    // Only prune the harness's own `bak.<version>.<unixtime>` files; never touch
    // foreign or operator-made files that happen to share the prefix.
    .filter((e): e is { name: string; t: number } => e.t !== null)
    .sort((a, b) => b.t - a.t || (a.name < b.name ? 1 : -1));
  for (const stale of entries.slice(keep)) {
    unlinkSync(join(dir, stale.name));
    log.info("migration.backup_pruned", { path: join(dir, stale.name) });
  }
}

function backupBeforeMigration(db: Database, dbPath: string, version: string, nowMs: number, keep: number): void {
  // Flush WAL into the main file so the copy is a complete, restorable DB.
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    log.warn("migration.checkpoint_failed", { error: e instanceof Error ? e.message : String(e) });
  }
  if (!existsSync(dbPath)) return;
  const dest = `${dbPath}.bak.${version}.${nowMs}`;
  copyFileSync(dbPath, dest);
  log.info("migration.backup_written", { path: dest, version });
  pruneBackups(dbPath, keep);
}

/**
 * Apply pending schema migrations in lexical version order, each inside its own
 * `BEGIN IMMEDIATE` transaction. Records every applied migration in `schema_versions`
 * (`version`, `applied_at`, `sha256`). Idempotent: already-applied versions are skipped,
 * and their recorded checksum is verified to detect drift.
 *
 * Concurrency: each migration re-checks `schema_versions` *under the write lock* before
 * applying, so a peer process that applied the same version between our snapshot read and
 * the lock acquisition is detected and skipped instead of crashing. (Tolerating a peer that
 * is mid-migration when we try to begin needs `PRAGMA busy_timeout`, which P0.3 adds.)
 *
 * Throws `MigrationError` on a failing migration (transaction rolled back), a checksum
 * mismatch, or a downgrade (binary older than the applied schema). Callers at the boot
 * boundary translate the throw into a non-zero process exit.
 */
export function applyMigrations(
  db: Database,
  source: string | RawMigration[],
  binaryVersion: number,
  opts: MigrationOptions = {},
): MigrationResult {
  const now = opts.now ?? (() => Date.now());
  const resolvedPath = opts.dbPath ?? (db as unknown as { filename?: string }).filename ?? ":memory:";
  const fileBackedPath = resolvedPath && resolvedPath !== ":memory:" ? resolvedPath : null;
  const keep = opts.keepBackups ?? DEFAULT_KEEP_BACKUPS;

  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_versions (" +
      "version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha256 TEXT NOT NULL)",
  );

  const appliedRows = db
    .query("SELECT version, sha256 FROM schema_versions")
    .all() as Array<{ version: string; sha256: string }>;
  const applied = new Map<string, string>(appliedRows.map((r) => [r.version, r.sha256]));

  let highestApplied = 0;
  for (const r of appliedRows) highestApplied = Math.max(highestApplied, numericVersion(r.version));

  if (binaryVersion < highestApplied) {
    log.error("migration.downgrade_refused", { binaryVersion, highestApplied });
    throw new MigrationError(
      "DOWNGRADE",
      `binary schema version ${binaryVersion} is older than the applied schema version ${highestApplied}; ` +
        "restore a backup to roll back the database explicitly",
    );
  }

  // Whether the DB already holds application tables (a fresh DB doesn't; a legacy DB
  // created before the harness does). Used to snapshot a populated DB before its first
  // harness-managed migration.
  const populatedAtEntry = countUserTables(db) > 0;
  opts._afterSnapshot?.();

  const migrations = prepare(source);
  const appliedThisRun: string[] = [];
  let appliedCount = applied.size;

  for (const m of migrations) {
    const known = applied.get(m.version);
    if (known !== undefined) {
      if (known !== m.sha256) {
        log.error("migration.checksum_mismatch", { version: m.version, expected: known, actual: m.sha256 });
        throw new MigrationError(
          "MIGRATION_CHECKSUM_MISMATCH",
          `migration ${m.version} changed after it was applied (checksum mismatch); migrations are immutable once shipped`,
          m.version,
        );
      }
      continue;
    }

    // Snapshot the prior good state before mutating an already-populated schema.
    if (fileBackedPath && (appliedCount > 0 || populatedAtEntry)) {
      backupBeforeMigration(db, fileBackedPath, m.version, now(), keep);
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check under the write lock: a peer may have applied this version between
      // our snapshot read and acquiring the lock.
      const peer = db.query("SELECT sha256 FROM schema_versions WHERE version = ?").get(m.version) as
        | { sha256: string }
        | null;
      if (peer) {
        db.exec("COMMIT");
        if (peer.sha256 !== m.sha256) {
          log.error("migration.checksum_mismatch", { version: m.version, expected: peer.sha256, actual: m.sha256 });
          throw new MigrationError(
            "MIGRATION_CHECKSUM_MISMATCH",
            `migration ${m.version} was applied concurrently with different content (checksum mismatch)`,
            m.version,
          );
        }
        log.info("migration.applied_by_peer", { version: m.version });
        applied.set(m.version, peer.sha256);
        appliedCount += 1;
        continue;
      }

      db.exec(m.sql);
      db.run("INSERT INTO schema_versions (version, applied_at, sha256) VALUES (?, ?, ?)", [
        m.version,
        new Date(now()).toISOString(),
        m.sha256,
      ]);
      db.exec("COMMIT");
    } catch (e) {
      if (e instanceof MigrationError) throw e; // peer checksum mismatch: tx already committed
      try {
        db.exec("ROLLBACK");
      } catch {
        // no active transaction to roll back
      }
      const message = e instanceof Error ? e.message : String(e);
      log.error("migration.failed", { version: m.version, error: message });
      throw new MigrationError("MIGRATION_FAILED", `migration ${m.version} failed: ${message}`, m.version);
    }

    appliedThisRun.push(m.version);
    appliedCount += 1;
    log.info("migration.applied", { version: m.version });
  }

  const cur = db.query("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1").get() as
    | { version: string }
    | null;
  return { applied: appliedThisRun, currentVersion: cur?.version ?? null };
}
