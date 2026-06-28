-- Operator overrides for discovered-workload classification (P1.5). An override pins a workload to
-- `application` or `infrastructure`, beating the default rules; adoption writes an `application` row.
CREATE TABLE IF NOT EXISTS workload_overrides (
  cluster_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL, -- application | infrastructure
  updated_at TEXT NOT NULL,
  PRIMARY KEY (cluster_id, namespace, kind, name)
);
