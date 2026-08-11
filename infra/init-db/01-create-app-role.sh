#!/bin/bash
# Runs once on first Postgres init (docker-entrypoint-initdb.d).
# Creates the runtime role the API connects as; migration 0003 then locks it
# down to append-only on evidence tables. Migrations themselves run as the
# owner role, never as pod_app.
set -euo pipefail

POD_APP_PASSWORD="${POD_APP_PASSWORD:-pod_app_dev_only}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE ROLE pod_app LOGIN PASSWORD '${POD_APP_PASSWORD}';
EOSQL
