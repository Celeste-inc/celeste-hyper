-- One-shot exec tokens (P3.2): a browser WebSocket can't send an Authorization header, so the
-- operator mints a single-use, short-TTL token bound to a specific (service, pod, container) and the
-- terminal WS redeems it. RCE-equivalent (a shell in a pod), so the mint is operator+ and
-- pod-ownership-checked; the token is the WS's only credential.
CREATE TABLE IF NOT EXISTS exec_tokens (
  token TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  pod TEXT NOT NULL,
  container TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
