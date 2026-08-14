# Proof of Delivery v2

An Android driver app and a deployed API, built on top of a live v1 system whose
handsets cannot be updated. Drivers record delivery evidence at the door with no
signal: the device database is the system of record until the server confirms
otherwise, and every attempt is append-only. The frozen v1 surface keeps
answering byte for byte what a v1.4.2 handset expects.

```
app/        Expo / React Native driver app
backend/    NestJS API, and the Docker build context the deploy ships
infra/      Terraform, docker-compose, Caddy, deploy.sh
loadtest/   k6 scenarios and their recorded results
```

## Try the deployed system

| | |
|---|---|
| API | https://18.139.240.68.sslip.io |
| API reference | https://18.139.240.68.sslip.io/api/docs |
| Android APK | https://pod-v2-apk-856942459927.s3.ap-southeast-1.amazonaws.com/pod-v2.apk |

The reference is executable. Every example body is pre-filled with working
credentials, so `POST /api/v2/auth/driver/login` needs *Try it out* and then
**Execute**, nothing typed. Paste the `accessToken` into the green **Authorize**
button and the rest of the page unlocks. `GET /api/health` runs with no token at
all and names the instance that answered.

The logins below are published deliberately. They are seeded demo accounts on a
demo database, created for this evaluation and holding no real personal data.

| Who | Sign in with |
|---|---|
| Driver, London round | `EMP-TEST-001` / `TestDriver#2026` |
| Driver, Karachi round | `EMP-PK-001` / `TestDriver#2026` |
| Office | `office@demo.pod` / `OfficeDemo#2026` |
| v1 frozen surface | `emp-test-001@fleet.local` / `TestDriver#2026` |

A driver's round is today's work, selected on `created_at >= date_trunc('day',
now())`, so seeded stops would otherwise expire at UTC midnight and these logins
would open on an empty day. A systemd timer rolls the round forward at 00:05
UTC, shifting stops only: evidence is append-only and keeps its original
timestamps, so a pod that predates its rolled stop is expected.

The v1 surface is dual-written, not reimplemented. A delivery recorded through
the new attempts model is projected into the old `pods` table in the same
transaction, so the old fleet keeps seeing what it expects:

```bash
curl -sS -X POST https://18.139.240.68.sslip.io/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"emp-test-001@fleet.local","password":"TestDriver#2026"}'
```

That returns exactly `{"token":"..."}` and nothing else. The same shape is
pinned by `backend/test/legacy-contract.e2e-spec.ts`.

## The Android app

`app/` is Expo with native modules, so `android/` and `ios/` are generated and
gitignored. A fresh clone runs prebuild before it can build anything:

```bash
cd app
npm ci
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease   # APK, for sideloading
npm test                                  # sync, evidence matrix, version gate
```

Release signing reads `~/.pod-v2-signing/keystore.properties`; without it a
normal build falls back to debug signing so a clean checkout still compiles.
`app/README.md` covers the Play bundle, which is a different build.

## The backend

```bash
docker compose -f infra/docker-compose.dev.yml up -d   # Postgres on 5433
cd backend
cp .env.example .env      # DATABASE_URL already points at 5433; set JWT_SECRET
npm ci
npm run migrate
npm run seed              # 5,000 stops, and it prints the demo logins
npm run start:dev         # API on :3000, reference at /api/docs
```

Local development uses that Postgres container. The deployed system does not:
see below.

```bash
npm run test:unit   # no database needed
npm test            # unit, then the e2e suite, which needs a seeded database
```

`AWS_PROFILE` in front of `start:dev` enables S3 presigning and Bedrock
summaries. Without it the API still runs: presigning fails softly and summaries
fall back to templates, which is the same degraded path used when Bedrock is
down.

## Where it runs

One `t3.small` in `ap-southeast-1` runs Caddy in front of two API instances, so
idempotency and SSE fan-out are exercised across instances rather than only
designed for. The database is an Aurora PostgreSQL Serverless v2 cluster in
private subnets, reachable only from the API host's security group, encrypted at
rest with automated backups. Evidence photographs live in a private S3 bucket
that the API never proxies: the attempt POST returns presigned links, the bytes
go straight to S3, and the server verifies each object afterwards.

`infra/terraform` provisions it and `infra/deploy.sh` ships a release.

## The rest of the documents

`DECISIONS.md` is the design write-up: what was chosen, what was refused, and
what breaks at 100x. `SCHEMA.md` is every table, column, constraint and grant,
read out of the deployed database rather than assembled from the migrations.
`PRIVACY.md` is the data map a regulator would ask for. `loadtest/` holds the k6
scenarios and `loadtest/results/RESULTS.md` the numbers they produced.
