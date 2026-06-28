import type { Database } from "bun:sqlite";
import type { State } from "./state.ts";

export interface AuditEvent {
  actor: string; // username, or "system" for worker steps
  role?: string | null;
  action: string;
  resourceKind?: string | null;
  resourceId?: string | null;
  payload?: unknown; // small context only — NEVER request bodies (avoid logging secrets)
  result: "ok" | "fail";
  message?: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  role: string | null;
  action: string;
  resource_kind: string | null;
  resource_id: string | null;
  payload: string | null;
  result: string;
  message: string | null;
}

const MAX_AUDIT_ROWS = 200_000; // ~tens of MB; bounds growth from authenticated denial-spam
const PRUNE_EVERY = 500;

/** Retain only the most recent `keep` rows (keyset by the monotonic id). No-op on an empty table. */
export function pruneAudit(state: State, keep: number): void {
  const db: Database = state.database;
  const max = (db.query("SELECT MAX(id) AS m FROM audit_events").get() as { m: number | null }).m;
  if (max === null) return;
  db.run("DELETE FROM audit_events WHERE id <= ?", [max - keep]);
}

/**
 * Append an audit row. Uses `state.database` directly so a call made inside `state.transaction(...)`
 * commits/rolls back atomically with the mutation it records — a rolled-back action leaves no row.
 * Opportunistically prunes (every `PRUNE_EVERY` inserts) so an authenticated client spamming denied
 * mutations can't grow the table without bound — the worst case is `MAX_AUDIT_ROWS + PRUNE_EVERY`.
 */
export function recordAudit(state: State, event: AuditEvent, nowMs: number): void {
  const db: Database = state.database;
  const res = db.run(
    "INSERT INTO audit_events (ts, actor, role, action, resource_kind, resource_id, payload, result, message) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      new Date(nowMs).toISOString(),
      event.actor,
      event.role ?? null,
      event.action,
      event.resourceKind ?? null,
      event.resourceId ?? null,
      event.payload === undefined ? null : JSON.stringify(event.payload),
      event.result,
      event.message ?? null,
    ],
  );
  if (Number(res.lastInsertRowid) % PRUNE_EVERY === 0) pruneAudit(state, MAX_AUDIT_ROWS);
}

export interface AuditQuery {
  since?: string;
  until?: string;
  actor?: string;
  action?: string;
  resourceKind?: string;
  result?: string;
  pageSize?: number;
  cursor?: string; // opaque "<ts>|<id>" of the last row seen
}

export interface AuditPage {
  items: AuditRow[];
  nextCursor: string | null;
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function decodeCursor(cursor: string): { ts: string; id: number } | null {
  const sep = cursor.lastIndexOf("|");
  if (sep < 0) return null;
  const ts = cursor.slice(0, sep);
  const id = Number(cursor.slice(sep + 1));
  if (!Number.isInteger(id)) return null;
  return { ts, id };
}

/**
 * Cursor-paginated audit read, newest first. The cursor is the `(ts, id)` of the last row returned;
 * keyset pagination over the `(ts, id)` index makes it stable under concurrent inserts (no OFFSET
 * drift). Filters are ANDed; `since`/`until` bound `ts` inclusively/exclusively.
 */
export function queryAudit(state: State, q: AuditQuery): AuditPage {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (q.since) (where.push("ts >= ?"), params.push(q.since));
  if (q.until) (where.push("ts < ?"), params.push(q.until));
  if (q.actor) (where.push("actor = ?"), params.push(q.actor));
  if (q.action) (where.push("action = ?"), params.push(q.action));
  if (q.resourceKind) (where.push("resource_kind = ?"), params.push(q.resourceKind));
  if (q.result) (where.push("result = ?"), params.push(q.result));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c) {
      // Keyset: rows strictly "older" than the cursor under (ts DESC, id DESC).
      where.push("(ts < ? OR (ts = ? AND id < ?))");
      params.push(c.ts, c.ts, c.id);
    }
  }
  const size = Math.min(Math.max(1, q.pageSize ?? DEFAULT_PAGE), MAX_PAGE);
  const sql =
    "SELECT * FROM audit_events" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY ts DESC, id DESC LIMIT ?";
  const rows = state.database.query(sql).all(...params, size + 1) as AuditRow[];
  const items = rows.slice(0, size);
  const nextCursor = rows.length > size && items.length > 0 ? `${items[items.length - 1]!.ts}|${items[items.length - 1]!.id}` : null;
  return { items, nextCursor };
}
