#!/usr/bin/env bash
# Deploy the backend stack to the EC2 host provisioned by terraform/.
# Usage: ./deploy.sh [--seed] [--migrate]
# First run generates server-side secrets in /home/ec2-user/pod-v2/.env
# (secrets live on the server only, never in the repo).
set -euo pipefail

cd "$(dirname "$0")"

HOST="${HOST:-$(terraform -chdir=terraform output -raw backend_public_ip)}"
DOMAIN="${DOMAIN:-${HOST}.sslip.io}"
S3_BUCKET="${S3_BUCKET:-$(terraform -chdir=terraform output -raw evidence_bucket)}"
SSH="ssh -o StrictHostKeyChecking=accept-new ec2-user@${HOST}"
REMOTE_DIR=/home/ec2-user/pod-v2

echo "==> Deploying to ${HOST} (https://${DOMAIN})"

echo "==> Syncing sources"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .env \
  ../backend "ec2-user@${HOST}:${REMOTE_DIR}/"
rsync -az docker-compose.prod.yml Caddyfile init-db "ec2-user@${HOST}:${REMOTE_DIR}/"
$SSH "mkdir -p ${REMOTE_DIR}/dashboard-dist"
if [ -d ../dashboard/dist ]; then
  rsync -az --delete ../dashboard/dist/ "ec2-user@${HOST}:${REMOTE_DIR}/dashboard-dist/"
fi

echo "==> Ensuring server .env"
$SSH "cd ${REMOTE_DIR} && if [ ! -f .env ]; then
  PG_PW=\$(openssl rand -hex 24)
  APP_PW=\$(openssl rand -hex 24)
  cat > .env <<ENV
NODE_ENV=production
PORT=3000
DOMAIN=${DOMAIN}
POSTGRES_USER=pod
POSTGRES_PASSWORD=\${PG_PW}
POSTGRES_DB=pod
POD_APP_PASSWORD=\${APP_PW}
DATABASE_URL=postgres://pod_app:\${APP_PW}@postgres:5432/pod
DATABASE_OWNER_URL=postgres://pod:\${PG_PW}@postgres:5432/pod
JWT_SECRET=\$(openssl rand -hex 48)
AWS_REGION=ap-southeast-1
S3_BUCKET=${S3_BUCKET}
BEDROCK_MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0
AI_ENABLED=true
DUAL_WRITE_PODS=true
MIN_APP_VERSION=1.0.0
LATEST_APP_VERSION=2.0.0
BLOCKED_APP_VERSIONS=
ENV
  chmod 600 .env
  echo 'generated new .env'
fi"

echo "==> Building image and starting stack"
$SSH "cd ${REMOTE_DIR} && docker build -t pod-backend:latest backend/ \
  && docker compose -f docker-compose.prod.yml --env-file .env up -d --remove-orphans"

if [[ "${*:-}" == *--migrate* ]]; then
  echo "==> Running migrations (as owner role)"
  $SSH "cd ${REMOTE_DIR} && docker compose -f docker-compose.prod.yml --env-file .env run --rm \
    -e DATABASE_URL=\$(grep '^DATABASE_OWNER_URL=' .env | cut -d= -f2-) \
    backend-1 node dist/database/migrate.js"
fi

if [[ "${*:-}" == *--seed* ]]; then
  echo "==> Seeding (as owner role)"
  $SSH "cd ${REMOTE_DIR} && docker compose -f docker-compose.prod.yml --env-file .env run --rm \
    -e DATABASE_URL=\$(grep '^DATABASE_OWNER_URL=' .env | cut -d= -f2-) \
    backend-1 node dist/database/seeds/seed.js"
fi

echo "==> Health"
sleep 3
curl -fsS "https://${DOMAIN}/api/health" && echo
echo "==> Done: https://${DOMAIN}"
