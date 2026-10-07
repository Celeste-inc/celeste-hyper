CREATE TABLE IF NOT EXISTS env_applied_hashes (
  service TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('config', 'secret')),
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  deployment_id INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (service, kind, key)
);
