# Proof-of-Delivery v2

Driver Android app + backend + office dashboard for capturing trustworthy proof-of-delivery evidence, extending a live v1 system without breaking its clients.

> Stub - final README (setup + architecture, under one page) written at ship time.

## Layout

```
app/        Expo React Native driver app (Android)
backend/    NestJS + TypeORM + Postgres API (v1-compatible + /api/v2)
dashboard/  Office live-status dashboard (React + Vite)
infra/      Terraform (EC2, S3, IAM) + docker-compose + Caddy
loadtest/   k6 scenarios + recorded results
```

See `DECISIONS.md` for the design decisions, migration plan, and measured numbers. See `PRIVACY.md` for the UK GDPR data map.
