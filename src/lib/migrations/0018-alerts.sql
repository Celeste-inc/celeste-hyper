CREATE TABLE IF NOT EXISTS alert_state (
  key TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  service TEXT NOT NULL,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_sent TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  open INTEGER NOT NULL DEFAULT 1,
  condition INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alert_state_open_condition ON alert_state (open, condition);
CREATE INDEX IF NOT EXISTS idx_alert_state_last_seen ON alert_state (last_seen);
CREATE TABLE IF NOT EXISTS alert_cursors (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
