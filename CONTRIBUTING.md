# Contributing

celeste-hyper is open source. `main` is protected — all changes land through a pull
request, reviewed and passing CI. Nobody, including maintainers, pushes directly to `main`.

## Workflow

1. Fork the repo (external contributors) or branch from `main` (maintainers).
2. Make your change. Keep PRs focused — one concern per PR.
3. Run the full check locally before opening the PR:

   ```bash
   bun run check
   ```

   This runs backend typecheck → backend tests → frontend typecheck → frontend tests →
   frontend build, the same gate CI enforces.
4. Open a PR against `main`. Fill in the PR template.
5. At least one maintainer approval and a green CI run are required to merge.
   Squash-merge is preferred to keep `main` history linear.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`chore:`, `docs:`, `test:`, …) — `release-please` derives version bumps and changelogs
from them.

## Code style

- TypeScript throughout (backend `src/`, frontend `frontend/src/`).
- No inline `CREATE TABLE` — schema changes go through `src/lib/migrations/` (see
  [`docs/operations.md`](./docs/operations.md#schema-migrations)).
- Pure logic split from I/O where feasible (ports/mockable seams) — see
  [`docs/architecture.md`](./docs/architecture.md) for existing patterns.

## Reporting bugs / requesting features

Use the issue templates. For security vulnerabilities, see [`SECURITY.md`](./SECURITY.md)
instead of a public issue.

## Code of Conduct

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). By participating you
agree to uphold it.
