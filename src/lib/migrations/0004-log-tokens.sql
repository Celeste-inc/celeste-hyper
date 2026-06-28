CREATE TABLE IF NOT EXISTS log_tokens (
  token TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
