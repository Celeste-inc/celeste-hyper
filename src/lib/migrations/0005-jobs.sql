-- Persistent background job queue (P0.7).
-- Invariant: for `kind='deploy'`, a job's `id` EQUALS its `deployments.id` (1:1). The enqueuer
-- creates the deployment row first (recordDeploymentStart) and enqueues the job with that id, so
-- `/api/deployments/:id` and `/api/jobs/:id` address the same logical operation.
-- `id INTEGER PRIMARY KEY` is a rowid alias: auto-assigned when omitted, settable explicitly.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT NOT NULL,         -- ISO-8601 UTC; lexicographically comparable
  lease_until TEXT,                      -- ISO-8601 UTC while running; NULL otherwise
  lease_holder TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fencing_token INTEGER NOT NULL DEFAULT 0
);

-- Drives the claim scan: oldest claimable job (pending, due) by id.
CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs (state, next_attempt_at, id);
