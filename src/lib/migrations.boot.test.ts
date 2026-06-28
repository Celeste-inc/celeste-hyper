import { describe, it, expect } from "bun:test";

const CWD = process.cwd();

function runBoot(script: string): { code: number; stderr: string } {
  const res = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, TZ: "UTC" } });
  return { code: res.exitCode, stderr: res.stderr.toString() };
}

describe("boot guard exits non-zero on migration failure", () => {
  it("downgrade: real State boot exits 1 with DOWNGRADE on stderr", () => {
    const script = `
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "${CWD}/src/lib/state.ts";
import { MigrationError } from "${CWD}/src/lib/migrations.ts";
const p = join(mkdtempSync(join(tmpdir(), "boot-dg-")), "state.sqlite");
const seed = new Database(p);
seed.exec("PRAGMA journal_mode = WAL");
seed.exec("CREATE TABLE schema_versions (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha256 TEXT NOT NULL)");
seed.run("INSERT INTO schema_versions VALUES ('0099-future', 't', 'x')");
seed.close();
try { new State(p); process.exit(0); }
catch (err) {
  process.stderr.write("BOOT_FAIL code=" + (err instanceof MigrationError ? err.code : "?"));
  process.exit(1);
}
`;
    const r = runBoot(script);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("DOWNGRADE");
  });

  it("failed migration: exits 1 with the failing version on stderr", () => {
    const script = `
import { Database } from "bun:sqlite";
import { applyMigrations, MigrationError } from "${CWD}/src/lib/migrations.ts";
const db = new Database(":memory:");
try {
  applyMigrations(db, [{ version: "0007-bad", sql: "THIS IS NOT SQL;" }], 7, { now: () => 1 });
  process.exit(0);
} catch (err) {
  process.stderr.write("BOOT_FAIL version=" + (err instanceof MigrationError ? err.version : "?"));
  process.exit(1);
}
`;
    const r = runBoot(script);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("0007-bad");
  });
});
