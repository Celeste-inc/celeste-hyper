import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../migrations.ts";
import { MIGRATIONS, BINARY_SCHEMA_VERSION } from "./index.ts";

describe("embedded migrations", () => {
  it("ships the expected version set", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([
      "0001-bootstrap",
      "0002-locks-and-fencing",
      "0003-users",
      "0004-log-tokens",
      "0005-jobs",
      "0006-capabilities",
      "0007-deployment-action",
      "0008-workload-overrides",
      "0009-deployments-health-gate",
      "0010-service-degraded",
      "0011-machine-tokens",
      "0012-webhooks",
      "0013-audit-events",
      "0014-exec-tokens",
      "0015-cluster-version",
    ]);
    expect(BINARY_SCHEMA_VERSION).toBe(15);
  });

  it("applies the embedded migrations and creates the documented schema", () => {
    const db = new Database(":memory:");
    const res = applyMigrations(db, MIGRATIONS, BINARY_SCHEMA_VERSION, { now: () => 1 });
    expect(res.applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(res.currentVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);

    const tables = (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_versions' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    // every table the migrations should have created is present (toContain survives future migrations)
    for (const t of ["audit_events", "cluster_capabilities", "clusters", "current_deployment", "deployments", "exec_tokens", "jobs", "locks", "log_tokens", "machine_tokens", "meta", "service_degraded", "services", "users", "webhooks", "workload_overrides"]) {
      expect(tables).toContain(t);
    }

    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_deployments_service_started'")
      .get();
    expect(idx).not.toBeNull();

    // current_deployment gained the fencing token column in 0002.
    const curCols = (db.query("PRAGMA table_info(current_deployment)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    expect(curCols).toEqual(["deployed_at", "service", "tag", "token"]);

    const lockCols = (db.query("PRAGMA table_info(locks)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    expect(lockCols).toEqual(["expires_at", "holder", "resource", "token"]);

    // cluster_capabilities gained the apiserver version column in 0015 (CC.5).
    const capCols = (db.query("PRAGMA table_info(cluster_capabilities)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    expect(capCols).toEqual(["capabilities", "cluster_id", "last_checked_at", "server_version"]);

    db.close();
  });

  it("is idempotent for the real migrations", () => {
    const db = new Database(":memory:");
    applyMigrations(db, MIGRATIONS, BINARY_SCHEMA_VERSION, { now: () => 1 });
    const res2 = applyMigrations(db, MIGRATIONS, BINARY_SCHEMA_VERSION, { now: () => 2 });
    expect(res2.applied).toEqual([]);
    expect(res2.currentVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    db.close();
  });
});
