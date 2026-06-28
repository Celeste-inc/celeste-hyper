-- A service is marked `degraded` when an automatic rollback (P1.9) itself fails — single-shot
-- safety so hyper doesn't storm deploy→rollback→deploy. Degraded services refuse new deploys
-- until an operator clears the flag.
CREATE TABLE IF NOT EXISTS service_degraded (
  service TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
