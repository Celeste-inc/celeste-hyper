import { describe, it, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "./lib/state.ts";
import { realClock } from "./lib/clock.ts";
import { run } from "./cli.ts";

function freshDb(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), "hyper-cli2-")), "state.sqlite");
  new State(dbPath, realClock()).close();
  return dbPath;
}

describe("cli run()", () => {
  it("prints usage (exit 2) for an empty or unknown command", () => {
    expect(run([]).code).toBe(2);
    expect(run(["state"]).code).toBe(2);
    expect(run(["state", "frobnicate", "--db=x"]).code).toBe(2);
    expect(run(["notstate", "backup"]).code).toBe(2);
  });

  it("--online prints the hot-backup advice and exits 0 (only for a known command)", () => {
    const { result, code } = run(["state", "backup", "--online"]);
    expect(code).toBe(0);
    expect(result.message).toContain(".backup");
    // --online does not rescue an unknown command from the usage/exit-2 path
    expect(run(["state", "frobnicate", "--online"]).code).toBe(2);
  });

  it("backup → migrate → restore round-trip via the dispatcher", () => {
    const dbPath = freshDb();
    const out = `${dbPath}.bak`;
    expect(run(["state", "backup", `--db=${dbPath}`, `--out=${out}`]).code).toBe(0);
    expect(existsSync(out)).toBe(true);

    expect(run(["state", "migrate", `--db=${dbPath}`]).code).toBe(0);

    const restoreTarget = join(mkdtempSync(join(tmpdir(), "hyper-cli3-")), "state.sqlite");
    expect(run(["state", "restore", `--db=${restoreTarget}`, `--from=${out}`]).code).toBe(0);
    expect(existsSync(restoreTarget)).toBe(true);
  });

  it("backup exits 1 with a clear message when --out is missing", () => {
    const dbPath = freshDb();
    const { result, code } = run(["state", "backup", `--db=${dbPath}`]);
    expect(code).toBe(1);
    expect(result.message).toContain("--out");
  });
});
