-- Enrollment tokens (P4.1): one-shot, short-TTL credentials a worker machine presents to
-- POST /api/enroll to register ITSELF as a cluster on the master. Admin-minted; the cleartext is
-- shown once and never stored — only an HMAC-SHA256 (keyed by the server auth secret, distinct key
-- domain from machine tokens) is kept, so a DB leak alone can't recover or forge a token. The token
-- pre-declares the cluster id/name/runtime/image-load the worker will become, so the worker can only
-- fill in the kubeconfig, never widen what it registers. Redemption is atomic + single-use
-- (used_at flips once), exactly like log_tokens.
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hash_sha256 TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  cluster_name TEXT NOT NULL,
  default_namespace TEXT NOT NULL DEFAULT 'default',
  runtime TEXT NOT NULL DEFAULT 'k3s',
  image_load TEXT NOT NULL DEFAULT 'remote-pull',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_hash ON enrollment_tokens(hash_sha256);
