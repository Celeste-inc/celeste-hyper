CREATE TABLE IF NOT EXISTS current_deployment (
  service TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  deployed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  tag TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployments_service_started
  ON deployments(service, started_at DESC);
CREATE TABLE IF NOT EXISTS services (
  name TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
