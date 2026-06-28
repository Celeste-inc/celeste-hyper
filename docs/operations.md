# Operations

Operational runbook for the celeste-hyper host process. This document grows as the
foundation items land; today it covers the **schema migration harness** (P0.0).

## Schema migrations

All persistent state lives in a single SQLite file at `<stateDir>/state.sqlite`
(default `stateDir` is `/var/lib/celeste-hyper`). Its schema is owned entirely by the
migration harness — there is no inline `CREATE TABLE` anywhere else in the codebase.

### How it works

- Every schema change is a file `src/lib/migrations/NNNN-description.sql`, where `NNNN`
  is a zero-padded integer. Files apply in **lexical order**, which equals numeric order
  because of the zero padding.
- The `.sql` files are imported as embedded text (`with { type: "text" }`) and registered
  in `src/lib/migrations/index.ts`. `bun build --compile` bundles them into the standalone
  binary, so the single artifact needs nothing on disk to migrate.
- On boot, `State` opens the DB (WAL mode) and calls `applyMigrations(db, MIGRATIONS, BINARY_SCHEMA_VERSION)`.
  Each pending migration runs inside its own `BEGIN IMMEDIATE` transaction.
- A bookkeeping table `schema_versions(version, applied_at, sha256)` records every applied
  migration. Re-running is a no-op: already-applied versions are skipped. This table is
  **harness-internal** — it is the one piece of schema created by `migrations.ts` itself
  rather than by a `NNNN-*.sql` file, the same way other migration tools own their ledger.
- Each migration re-checks `schema_versions` under the write lock before applying, so two
  processes booting concurrently against the same file don't double-apply. (Tolerating a
  peer that is *mid-migration* when the second process tries to begin needs `PRAGMA
  busy_timeout`, added in P0.3.)

### Adding a migration

1. Create `src/lib/migrations/000N-what-it-does.sql` with the new DDL.
2. Append `{ version: "000N-what-it-does", sql: <import> }` to `src/lib/migrations/index.ts`.
3. Write/extend the migration test asserting apply + idempotency.
4. **Never edit a migration that has shipped.** The harness stores each migration's SHA-256
   and refuses to boot (`MIGRATION_CHECKSUM_MISMATCH`) if a recorded migration's content
   changed. Fix-forward with a new file instead.

### Backups

Before applying a migration to a **non-empty** database (one that already has application
tables — including a legacy DB created before the harness), the harness checkpoints the WAL
into the main file and copies it to `state.sqlite.bak.<version>.<unixtime>` next to the live
DB, where `<unixtime>` is the Unix epoch in **milliseconds**. Only the **newest 5** backups
are kept (pruned by numeric timestamp); files that share the prefix but don't match the
`bak.<version>.<digits>` pattern are never touched. The first migration on a brand-new empty
database has nothing to back up and is skipped. Backups match `state.sqlite*` in
`.gitignore`, so they never get committed.

### Failure & recovery

| Situation | Symptom | Recovery |
|---|---|---|
| A migration's SQL fails | Transaction rolls back (DB unchanged); `migration.failed` with the failing version on stderr; process exits non-zero. The pre-migration backup is preserved, **not** auto-promoted. | Fix the migration file and reboot, or restore a `state.sqlite.bak.*` manually. |
| Downgrade (older binary on a newer DB) | `migration.downgrade_refused`; `MigrationError code=DOWNGRADE`; process exits non-zero. | Run a binary at least as new as the DB, or restore the matching backup explicitly. |
| Migration content drifted | `migration.checksum_mismatch`; process exits non-zero. | Restore the original migration file; never mutate shipped migrations. |

On a bad migration the DB rolls back, the pre-migration backup is preserved next to the file,
and the process exits non-zero.

### Manual restore

The harness never overwrites the live DB with a backup automatically. To roll back:

```bash
systemctl stop celeste-hyper        # ensure the process is not running
cp /var/lib/celeste-hyper/state.sqlite.bak.<version>.<unixtime> \
   /var/lib/celeste-hyper/state.sqlite
systemctl start celeste-hyper
```

### Backup / restore / migrate CLI (P2.4)

An **offline** state CLI (run with the process stopped). The server writes a PID-stamped
`state.sqlite.lock` at boot and removes it on graceful shutdown; the CLI refuses to touch the DB
while that lock names a live process (pass `--force` only if you've confirmed the pid is gone — e.g.
after a crash left a stale lock).

```bash
# stop the process first (the CLI refuses on a live lock)
bun src/cli.ts state backup  --out=/backups/state-$(date +%s).db   # VACUUM INTO: compacted, WAL-free copy
bun src/cli.ts state restore --from=/backups/state-….db            # validate (migrate a temp copy) then swap in
bun src/cli.ts state migrate                                       # apply pending migrations and exit (idempotent)
```

`--db=<path>` overrides the default (`$HYPER_STATE_DIR/state.sqlite`). `restore` validates that the
source applies cleanly through the migration harness on a temp copy **before** overwriting the target
(a source from a newer binary is refused by downgrade protection, and the target is left untouched on
any validation failure). Exit codes: `0` ok, `1` operation refused/failed, `2` usage.

For an **online** (hot, zero-downtime) backup of a running process, use SQLite's backup API instead —
`bun src/cli.ts state backup --online` prints the exact command:

```bash
sqlite3 /var/lib/celeste-hyper/state.sqlite ".backup '/var/lib/celeste-hyper/state.sqlite.bak'"
```

> Out of scope for P0.0: online (zero-downtime) migrations. The process pauses to apply. Online
> *restore* and encrypted backups are out of scope for P2.4.

## Testing

One command gates every change:

```bash
bun run check
```

It runs, in order: backend typecheck (`tsc --noEmit`) → backend tests (`bun test`) →
frontend typecheck (`tsc -b`) → frontend tests (`vitest run`) → frontend build
(`vite build`). A green `check` is the merge bar.

Run the layers individually while iterating:

| Command | What it runs |
|---|---|
| `bun test` | Backend unit/integration tests. Scoped to `src/` via `bunfig.toml` (`[test] root`), so it does **not** pick up the frontend's Vitest `*.test.tsx`. |
| `bun test src/lib/migrations.test.ts` | A single backend test file. |
| `bun run --cwd frontend test` | Frontend component tests (Vitest in jsdom). |
| `bun run typecheck` / `bun run --cwd frontend typecheck` | Types only. |

Conventions:

- Backend tests use `bun:test` and `app.handle(new Request(...))` — no server boot, no port.
- Frontend tests use Vitest + `@testing-library/react` in jsdom. Shared mocks (default
  `fetch`, an `EventSource` shim, a `localStorage` guard) live in `frontend/test/setup.ts`;
  CSS is skipped (`css: false`) so Tailwind's pipeline never touches jsdom.
- Set `TZ=UTC` in CI so time-formatting assertions are deterministic.

## Authentication & first-run

Every `/api/*` route requires auth except `/api/health`, `/api/login`, `/api/version`. Passwords
are hashed with **argon2id**.

**First boot** (no users): hyper auto-creates a **temporary `admin` / `admin`** with
`mustChangePassword` set and logs `auth.default_admin_created`. Log in and change the password
**immediately** — the UI forces it; via API:

```bash
# log in (stores the session cookie), then change the password
curl -fsS -c /tmp/j -X POST http://127.0.0.1:8080/api/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}'
curl -fsS -b /tmp/j -X POST http://127.0.0.1:8080/api/change-password \
  -H 'content-type: application/json' \
  -d '{"currentPassword":"admin","newPassword":"<strong-new-password>"}'
```

| Env var | Purpose |
|---|---|
| `HYPER_JWT_SECRET` | HS256 session-signing secret (**≥32 chars** or the process exits non-zero). If unset, a 32-byte random secret is generated on first boot and persisted in the `meta` table; set it explicitly to share across replicas / rotate. |

`POST /api/login` is rate-limited to 5 attempts/minute **per client IP and per username**
(`X-Forwarded-For` is the IP source, so terminate TLS at a trusted proxy that *overwrites* it;
the per-username limit guards against XFF spoofing). The login cookie value is the bearer token
for CLI use.

