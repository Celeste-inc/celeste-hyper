import type { Database } from "bun:sqlite";
import { type Clock, realClock } from "./clock.ts";

export interface Lock {
  resource: string;
  holder: string;
  token: number;
  expiresAt: number;
}

interface LockRow {
  holder: string;
  token: number;
  expires_at: number;
}

/**
 * Acquire a per-resource lock. Returns a `Lock` (with a monotonically increasing fencing
 * token) when the resource is free or its TTL has expired; returns `null` while another
 * holder's lock is still live. Tokens strictly increase per resource across acquisitions,
 * even after release/expiry, so a reclaimed lock always out-ranks the previous holder.
 */
export function acquireLock(
  db: Database,
  resource: string,
  holder: string,
  ttlMs: number,
  clock: Clock = realClock(),
): Lock | null {
  // Atomic within one process: bun:sqlite .get()/.run() are synchronous and there is no
  // `await` between the SELECT and the upsert, so no other JS interleaves. (Cross-process
  // serialization is out of scope — see plan P0.3 "Out of scope: distributed locks".)
  const now = clock.now();
  const row = db.query("SELECT holder, token, expires_at FROM locks WHERE resource = ?").get(resource) as
    | LockRow
    | null;
  if (row && row.expires_at > now) return null; // still held by someone
  const token = (row?.token ?? 0) + 1;
  const expiresAt = now + ttlMs;
  db.run(
    "INSERT INTO locks (resource, holder, token, expires_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(resource) DO UPDATE SET holder = excluded.holder, token = excluded.token, expires_at = excluded.expires_at",
    [resource, holder, token, expiresAt],
  );
  return { resource, holder, token, expiresAt };
}

/** Release a lock held by `holder` (no-op if held by someone else). */
export function releaseLock(db: Database, resource: string, holder: string): void {
  db.run("UPDATE locks SET expires_at = 0 WHERE resource = ? AND holder = ?", [resource, holder]);
}

/**
 * Extend the TTL of a lock we still hold, identified by (resource, holder, token). Returns false
 * if the row no longer matches — i.e. another acquisition (higher token) took it, or it was
 * released — which tells a running worker it has lost the lock and must abort. Never re-acquires.
 */
export function renewLock(
  db: Database,
  resource: string,
  holder: string,
  token: number,
  ttlMs: number,
  clock: Clock = realClock(),
): boolean {
  const r = db.run("UPDATE locks SET expires_at = ? WHERE resource = ? AND holder = ? AND token = ?", [
    clock.now() + ttlMs,
    resource,
    holder,
    token,
  ]);
  return r.changes > 0;
}

/**
 * Fencing-gated write to `current_deployment`: applies the tag only if `token` is at least
 * the stored token (gate `current_token <= :token`, per SDD §6 and plan P0.7). A strictly
 * lower (stale/zombie) token is a no-op; an equal token re-applies idempotently, so a
 * same-holder retry of a committed-but-BUSY-reported write is not falsely fenced out.
 * Returns whether the write took effect. This is the SQL gate the P0.7 worker uses.
 */
export function fencedSetCurrent(
  db: Database,
  service: string,
  tag: string,
  token: number,
  clock: Clock = realClock(),
): boolean {
  const deployedAt = new Date(clock.now()).toISOString();
  const r = db.run(
    "INSERT INTO current_deployment (service, tag, deployed_at, token) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(service) DO UPDATE SET tag = excluded.tag, deployed_at = excluded.deployed_at, token = excluded.token " +
      "WHERE excluded.token >= current_deployment.token",
    [service, tag, deployedAt, token],
  );
  return r.changes > 0;
}
