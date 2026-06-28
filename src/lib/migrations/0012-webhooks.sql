-- Registry push webhooks (P1.10): an inbound endpoint at /api/webhooks/registry/:secretId that a
-- container registry calls on a new tag. The :secretId path segment is an unguessable capability
-- (the URL itself authorizes reaching the row); the body is additionally HMAC-verified against
-- hmac_secret. On a verified push, hyper enqueues deploys for managed services whose imageRef
-- matches the pushed image. `kind` selects the payload parser (dockerhub|ghcr|acr|generic).
-- An optional service_scope/cluster_scope bounds the blast radius: an unscoped webhook deploys any
-- managed registry-pull service whose imageRef matches the push, while a scoped one is confined to
-- the named service / the services of the named cluster.
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  secret_id TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  service_scope TEXT,
  cluster_scope TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhooks_secret_id ON webhooks(secret_id);
