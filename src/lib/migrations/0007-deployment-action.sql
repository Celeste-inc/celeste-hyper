-- Distinguish rollbacks from forward deploys in the audit/history (P1.1).
-- Existing rows predate the column and are forward deploys, hence the default.
ALTER TABLE deployments ADD COLUMN action TEXT NOT NULL DEFAULT 'deploy';
