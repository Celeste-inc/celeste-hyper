-- Audit trail (P2.1): one row per mutation (HTTP or worker), recorded with the action's outcome.
-- `recordAudit` can be called inside the mutation's transaction, so a rolled-back action leaves no
-- row. `actor` is the username (or "system" for worker steps). Reads are paginated by (ts, id).
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT,
  action TEXT NOT NULL,
  resource_kind TEXT,
  resource_id TEXT,
  payload TEXT,
  result TEXT NOT NULL,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts_id ON audit_events(ts, id);
