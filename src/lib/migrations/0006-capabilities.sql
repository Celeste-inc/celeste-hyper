-- Per-cluster capability cache (P0.8). `capabilities` is a JSON map of
-- { <key>: { value, source:"cluster", lastCheckedAt, error? } } for cluster-level probes only;
-- host-level capabilities (helm/k3s/ctr CLIs) live in the `meta` table under `host_capabilities`,
-- since they apply to every cluster this binary serves.
CREATE TABLE IF NOT EXISTS cluster_capabilities (
  cluster_id TEXT PRIMARY KEY,
  capabilities TEXT NOT NULL,
  last_checked_at TEXT NOT NULL
);
