# Backend

NestJS + TypeORM + Postgres. Serves the frozen v1 surface and `/api/v2` from
one write path, so evidence rules cannot diverge between them.

See the repository root for [DECISIONS.md](../DECISIONS.md),
[PRIVACY.md](../PRIVACY.md) and deployment.

## Run locally

```bash
# Postgres must be running and the database created:
#   createdb -p 5433 -O pod pod
cp .env.example .env      # set DATABASE_URL and JWT_SECRET
npm install
npm run migration:run
npm run seed              # prints the demo logins
AWS_PROFILE=personal npm run start:dev
```

`AWS_PROFILE` is needed for S3 presigning and Bedrock summaries. Without it
the API still runs: presigning fails softly and summaries fall back to
templates, which is the same degraded path used when Bedrock is down.

## Tests

```bash
npm test          # unit: the evidence matrix, AI output validation
npm run test:e2e  # needs a seeded database
```

The e2e suite covers the parts worth protecting: concurrent submissions of
one idempotency key producing exactly one row, refresh-token rotation under
a racing burst, and the v1 response shape.

## Scripts

| Script | Purpose |
|---|---|
| `npm run migration:run` | Apply migrations (run as the owner role) |
| `npm run seed` | 5,000 stops, 33 drivers, 3,000 legacy pods rows |
| `npm run backfill:pods` | The v1 to v2 backfill, checkpointed and self-verifying |
| `npm run reset:demo` | Clear synthetic load-test rows |
| `./scripts/demo-day.sh` | Write a believable delivery day through the API |

## Layout

```
src/
  domain/outcomes.ts    the evidence matrix: one source of truth
  modules/attempts/     THE write path: idempotency, evidence, projection
  modules/legacy/       frozen v1 adapter + shape-pinned contract tests
  modules/media/        presign, and verify against S3 at finalize
  modules/sync/         delta sync, per-table keyset cursors
  modules/office/       live feed (SSE over LISTEN/NOTIFY), listing
  modules/ai/           Bedrock: timeout, breaker, cache, template fallback
  common/               guards, throttling, cursors
  database/migrations/  numbered expand/contract steps
```
