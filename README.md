# Proof-of-Delivery v2 - Backend

API, infrastructure, and office dashboard for capturing trustworthy proof-of-delivery evidence, extending a live v1 system without breaking its clients.

The Android driver app lives in the companion repository: **[pod-v2-app](https://github.com/buttawb/pod-v2-app)**.

- **API:** https://18.139.240.68.sslip.io
- **Test driver login:** `EMP-TEST-001` / `TestDriver#2026`
- **Office login:** `office@demo.pod` / `OfficeDemo#2026`

## Layout

```
backend/    NestJS + TypeORM + Postgres API (frozen v1 surface + /api/v2)
dashboard/  Office live-status dashboard (React + Vite)
infra/      Terraform (EC2, S3, IAM) + docker-compose + Caddy + deploy.sh
loadtest/   k6 scenarios + recorded results
```

> Stub - final README (setup + architecture, under one page) written at ship time.

See `DECISIONS.md` for the design decisions, migration plan, and measured numbers. See `PRIVACY.md` for the UK GDPR data map.
