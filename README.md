# Proof-of-Delivery v2 - Backend

API and infrastructure for capturing proof-of-delivery
evidence, extending a live v1 system without breaking its clients.

Driver app: **[pod-v2-app](https://github.com/buttawb/pod-v2-app)**.
Design rationale: **[DECISIONS.md](DECISIONS.md)**. Data protection:
**[PRIVACY.md](PRIVACY.md)**. Load numbers:
**[loadtest/results/RESULTS.md](loadtest/results/RESULTS.md)**.

## Try it

| | |
|---|---|
| API | https://18.139.240.68.sslip.io |
| API reference | https://18.139.240.68.sslip.io/api/docs |
| Android APK | https://pod-v2-apk-856942459927.s3.ap-southeast-1.amazonaws.com/pod-v2.apk |
| Driver login | `EMP-TEST-001` / `TestDriver#2026` |
| Office login | `office@demo.pod` / `OfficeDemo#2026` |

Seeded with 5,000 stops across Greater London for today, 150 of them on the
test driver's route, plus 3,000 historical v1 `pods` rows so the backfill can
be run and verified against real data.

## Architecture

```
Driver app ──┐                    ┌── Postgres (evidence, append-only)
             ├── Caddy (TLS, LB) ─┤
Dashboard ───┘   backend x2       ├── S3 (photos, presigned, private)
                                  └── Bedrock (customer summaries)
```

- **`backend/`** NestJS + TypeORM. The frozen v1 surface (`/api/stops`) and
  `/api/v2` are served by one write path, so evidence rules cannot diverge.
  Photos never transit the API: clients PUT directly to S3 on presigned URLs
  and the server verifies each object with `HeadObject`.
- **`infra/`** Terraform for EC2, S3, IAM (no static credentials anywhere),
  plus `deploy.sh` and the Caddy/Compose stack. Two API containers run behind
  the load balancer, so the multi-instance assumption is exercised, not assumed.
- **`loadtest/`** k6 scenarios and recorded results.

## Layout

```
backend/src/
  domain/outcomes.ts        the evidence matrix; one source of truth
  modules/attempts/         THE write path: idempotency, evidence, projection
  modules/legacy/           frozen v1 adapter + shape-pinned contract tests
  modules/media/            presign and verify
  modules/sync/             delta sync for the app
  modules/office/           live feed (SSE) and listing
  modules/ai/               Bedrock summaries with timeout, breaker, fallback
  database/migrations/      numbered expand/contract steps
scripts/backfill-pods.ts    checkpointed, resumable, self-verifying
```

## Run it locally

```bash
# 1. A Postgres the API can reach (any 14+ will do):
createdb -p 5433 -O pod pod   # after: CREATE ROLE pod LOGIN PASSWORD '...';

# 2. The API
cd backend && cp .env.example .env      # point DATABASE_URL at that database
npm install
npm run migration:run
npm run seed                            # prints the demo logins
AWS_PROFILE=personal npm run start:dev  # profile is for S3 presign + Bedrock

```

Tests: `npm test` (unit) and `npm run test:e2e` (needs a seeded database).
The e2e suite covers the idempotency race under concurrency, the evidence
matrix, refresh-token rotation, and the v1 contract shape.

## Deploy

```bash
cd infra/terraform && terraform apply   # EC2, S3, IAM
cd .. && ./deploy.sh --migrate --seed
```

Secrets are generated on the server at first deploy and never committed.
Migrations run as the owner role; the API connects as `pod_app`, which holds
no `UPDATE` or `DELETE` on evidence tables.
