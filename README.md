# Proof of Delivery v2

An Android driver app and a deployed API, built on top of a live v1 system whose
handsets cannot be updated. Two repositories:

- **Backend** (this repo) — https://github.com/buttawb/pod-v2-backend
- **Driver app** — https://github.com/buttawb/pod-v2-app

## Try it

| | |
|---|---|
| API | https://18.139.240.68.sslip.io |
| API docs | https://18.139.240.68.sslip.io/api/docs (Authorize with a token from any login below) |
| Android APK | _see releases / link in the submission email_ |
| Driver login | `EMP-TEST-001` / `TestDriver#2026` (London round, 151 stops) |
| Karachi round | `EMP-PK-001` / `TestDriver#2026` (320-stop depot, 40-stop round) |
| Office login | `office@demo.pod` / `OfficeDemo#2026` |

## Run it locally

```bash
git clone https://github.com/buttawb/pod-v2-backend && cd pod-v2-backend
docker compose -f infra/docker-compose.dev.yml up -d      # Postgres on 5433
cd backend && npm ci && npm run migrate && npm run seed   # schema + 5,000 stops
npm run start:dev                                         # API on :3000, docs at /api/docs
cd ../../pod-v2-app && npm ci && npx expo run:android      # driver app on a device
```

## How it fits together

The device database is the system of record until the server confirms
otherwise. Every screen reads SQLite; the network only ever writes to it, which
is what makes a cold start in a basement render the full day.

Capture writes a draft, and one conditioned UPDATE finalizes it. A background
worker then drives each attempt through submit, upload and finalize, keyed on a
client-generated UUID so a retry is never a second delivery.

Evidence is append-only, enforced by the database rather than by the
application: the runtime role holds no DELETE on `delivery_attempts` or
`attempt_photos`, and its UPDATE grant names four bookkeeping columns one by
one. Photographs go straight to a private bucket by presigned PUT and are only
ever read back through an authenticated, short-lived redirect.

The v1 surface is frozen and dual-written. A delivery recorded through the new
attempts model is projected into the old `pods` table in the same transaction,
so a v1.4.2 handset that will never be updated keeps seeing what it expects.

`SCHEMA.md` has every table, column, constraint and grant, read out of the
deployed database rather than assembled from the migrations.

## The frozen v1 contract

Pinned by the e2e suite in `backend/test/legacy-contract.e2e-spec.ts` (it needs a
database, and skips loudly without one), and verified by curl against the
deployed API on 2026-08-12.

Check it by hand:

```bash
curl -sS -X POST https://18.139.240.68.sslip.io/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"emp-test-001@fleet.local","password":"TestDriver#2026"}'
```

```bash
TOKEN=$(curl -sS -X POST https://18.139.240.68.sslip.io/api/auth/login -H 'Content-Type: application/json' -d '{"email":"emp-test-001@fleet.local","password":"TestDriver#2026"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])') && curl -sS https://18.139.240.68.sslip.io/api/stops -H "Authorization: Bearer $TOKEN" | head -c 600
```

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://18.139.240.68.sslip.io/api/stops/$STOP_ID/pod" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"delivered":true,"note":"hand check"}'
```

The first returns exactly `{"token":"..."}` and nothing else. The second returns
the full array with a `pod` object on every delivered stop, including deliveries
recorded through v2. The third returns 201 the first time and 409 on a repeat
for the same stop.
