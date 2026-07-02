import bootstrap from "./0001-bootstrap.sql" with { type: "text" };
import locksAndFencing from "./0002-locks-and-fencing.sql" with { type: "text" };
import users from "./0003-users.sql" with { type: "text" };
import logTokens from "./0004-log-tokens.sql" with { type: "text" };
import jobs from "./0005-jobs.sql" with { type: "text" };
import capabilities from "./0006-capabilities.sql" with { type: "text" };
import deploymentAction from "./0007-deployment-action.sql" with { type: "text" };
import workloadOverrides from "./0008-workload-overrides.sql" with { type: "text" };
import deploymentsHealthGate from "./0009-deployments-health-gate.sql" with { type: "text" };
import serviceDegraded from "./0010-service-degraded.sql" with { type: "text" };
import machineTokens from "./0011-machine-tokens.sql" with { type: "text" };
import webhooks from "./0012-webhooks.sql" with { type: "text" };
import auditEvents from "./0013-audit-events.sql" with { type: "text" };
import execTokens from "./0014-exec-tokens.sql" with { type: "text" };
import clusterVersion from "./0015-cluster-version.sql" with { type: "text" };
import enrollmentTokens from "./0016-enrollment-tokens.sql" with { type: "text" };
import type { RawMigration } from "../migrations.ts";

/**
 * Schema migrations embedded into the single binary as text. `bun build --compile`
 * bundles the `.sql` files, so the standalone binary needs nothing on disk.
 * Add new schema only by appending a `NNNN-description.sql` file and a line here;
 * never edit a shipped migration (the harness checksum guard rejects drift).
 */
export const MIGRATIONS: RawMigration[] = [
  { version: "0001-bootstrap", sql: bootstrap },
  { version: "0002-locks-and-fencing", sql: locksAndFencing },
  { version: "0003-users", sql: users },
  { version: "0004-log-tokens", sql: logTokens },
  { version: "0005-jobs", sql: jobs },
  { version: "0006-capabilities", sql: capabilities },
  { version: "0007-deployment-action", sql: deploymentAction },
  { version: "0008-workload-overrides", sql: workloadOverrides },
  { version: "0009-deployments-health-gate", sql: deploymentsHealthGate },
  { version: "0010-service-degraded", sql: serviceDegraded },
  { version: "0011-machine-tokens", sql: machineTokens },
  { version: "0012-webhooks", sql: webhooks },
  { version: "0013-audit-events", sql: auditEvents },
  { version: "0014-exec-tokens", sql: execTokens },
  { version: "0015-cluster-version", sql: clusterVersion },
  { version: "0016-enrollment-tokens", sql: enrollmentTokens },
];

/** Highest schema version this binary knows; used for downgrade protection. */
export const BINARY_SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => {
  const n = parseInt(m.version, 10);
  return Number.isNaN(n) ? max : Math.max(max, n);
}, 0);
