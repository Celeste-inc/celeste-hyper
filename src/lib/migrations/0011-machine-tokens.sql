-- Machine tokens (P1.10): long-lived, non-human bearer credentials for CI/CD. The cleartext is
-- shown once at creation and never stored; only an HMAC-SHA256 (keyed by the server auth secret)
-- of the token is kept, so a DB leak alone can't recover or forge a token. Tokens carry a role
-- (operator|viewer, never admin) and an optional service/cluster scope that further restricts them.
CREATE TABLE IF NOT EXISTS machine_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  hash_sha256 TEXT NOT NULL,
  role TEXT NOT NULL,
  service_scope TEXT,
  cluster_scope TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_machine_tokens_hash ON machine_tokens(hash_sha256);
