#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# aurora-bulk-seed.sh
#
# Loads a large synthetic history into Aurora so the read paths can be measured
# against something the size of the real system rather than a demo round. The
# brief describes 3,000 drivers and 14M rows; this builds 3,000 synthetic
# drivers, 14M stops and 20M delivery attempts on top of them.
#
# WHAT IT DOES NOT TOUCH. The two demo drivers, EMP-TEST-001 and EMP-PK-001,
# and every stop and attempt belonging to them. The functional demo has to stay
# small and faithful: a reviewer signing in as EMP-TEST-001 should still see a
# believable day of 151 stops, not a driver with a decade of history. Every row
# here belongs to a driver whose employee_ref starts EMP-BULK-, and the delete
# at the bottom of this comment is the whole undo:
#
#   DELETE FROM delivery_attempts a USING drivers d
#     WHERE d.id = a.driver_id AND d.employee_ref LIKE 'EMP-BULK-%';
#   DELETE FROM stops s USING drivers d
#     WHERE d.id = s.driver_id AND d.employee_ref LIKE 'EMP-BULK-%';
#   DELETE FROM drivers WHERE employee_ref LIKE 'EMP-BULK-%';
#
# Note that undo runs as the owner. pod_app cannot delete any of it, which is
# the same append-only posture the real evidence is under.
#
# IDs are derived from the row number rather than random, in four disjoint uuid
# ranges (stops 00000000-, drivers 00000001-, attempts 00000002-, client ids
# 00000003-). That makes the load restartable without duplicating rows, keeps
# the synthetic data instantly recognisable in any query result, and means a
# child row can name its parent without a join.
#
# Every row satisfies the real constraints. The three that actually bite:
# left_with_neighbour must carry a house number, refused and access_failure must
# carry a reason code, and declared_photo_count must be 0 to 4. These rows
# declare no photographs, which is honest: there are no S3 objects behind them,
# and source is 'backfill' rather than 'v2' for the same reason.
# ---------------------------------------------------------------------------
set -euo pipefail

HOST="${HOST:-18.139.240.68}"
SSH_USER="${SSH_USER:-ec2-user}"
AURORA_HOST="${AURORA_HOST:?set AURORA_HOST to the cluster writer endpoint}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
SECRET_NAME="${SECRET_NAME:-pod-v2/runtime}"

DRIVERS="${DRIVERS:-3000}"
STOPS="${STOPS:-14000000}"
ATTEMPTS="${ATTEMPTS:-20000000}"
CHUNK="${CHUNK:-1000000}"

SSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=25 ${SSH_USER}@${HOST}"

# psql on the box, as the owner. The password never crosses this laptop: the
# instance reads it from Secrets Manager with its own IAM role.
psql_remote() {
  $SSH "set -euo pipefail
PW=\$(aws secretsmanager get-secret-value --secret-id '${SECRET_NAME}' --region '${AWS_REGION}' \
  --query SecretString --output text | python3 -c 'import json,sys;print(json.load(sys.stdin)[\"POSTGRES_PASSWORD\"])')
docker run --rm -i -e PGPASSWORD=\"\$PW\" -e PGSSLMODE=require postgres:16-alpine \
  psql -h '${AURORA_HOST}' -U pod -d pod -v ON_ERROR_STOP=1 -q -t -A"
}

say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$1"; }

say "drivers: ${DRIVERS}   stops: ${STOPS}   attempts: ${ATTEMPTS}   chunk: ${CHUNK}"

# --- drivers ---------------------------------------------------------------
say "synthetic drivers"
psql_remote <<SQL
INSERT INTO drivers (id, employee_ref, display_name, password_hash, is_active, created_at)
SELECT ('00000001-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
       'EMP-BULK-' || lpad(g::text, 6, '0'),
       'Bulk Driver ' || g,
       -- Not a usable credential. bcrypt hashes start \$2b\$; this deliberately
       -- does not, so no synthetic driver can ever authenticate.
       'nologin-synthetic-fixture',
       true,
       now() - ((g % 700) || ' days')::interval
FROM generate_series(1, ${DRIVERS}) g
ON CONFLICT (employee_ref) DO NOTHING;
SELECT 'drivers now ' || count(*) FROM drivers WHERE employee_ref LIKE 'EMP-BULK-%';
SQL

# --- stops -----------------------------------------------------------------
# Chunked so that a failure costs one chunk rather than the whole load, and so
# progress is visible. ON CONFLICT DO NOTHING on the derived primary key is what
# makes a re-run resume instead of duplicating.
say "stops"
lo=1
while [ "$lo" -le "$STOPS" ]; do
  hi=$(( lo + CHUNK - 1 )); [ "$hi" -gt "$STOPS" ] && hi=$STOPS
  psql_remote <<SQL
INSERT INTO stops (id, driver_id, address, postcode, location, lat, lng, sequence,
                   status, expected_barcode, created_at, updated_at)
SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
       ('00000001-0000-4000-8000-' || lpad(to_hex(1 + (g % ${DRIVERS})), 12, '0'))::uuid,
       (1 + (g % 400)) || ' ' || (ARRAY['Church Road','Station Road','High Street','Mill Lane',
                                        'Victoria Road','Green Lane','Park Avenue','Kings Road'])[1 + (g % 8)],
       'E' || (1 + (g % 20)) || ' ' || (1 + (g % 9)) || (ARRAY['AA','BQ','DL','JS','PL','QN'])[1 + (g % 6)],
       -- location is the frozen v1 string form; lat and lng are the v2 numeric
       -- pair. Both are stored, and both have to agree.
       (51.35 + ((g % 5000)::numeric / 10000))::text || ',' || (-0.35 + ((g % 7000)::numeric / 10000))::text,
       51.35 + ((g % 5000)::numeric / 10000),
       -0.35 + ((g % 7000)::numeric / 10000),
       1 + (g % 180),
       (ARRAY['delivered','delivered','delivered','attempted','failed','pending'])[1 + (g % 6)],
       'JD' || lpad(((g::bigint * 7919) % 1000000000)::text, 10, '0'),
       -- Two years of history, so a date-ranged read has something to range over.
       now() - ((g % 730) || ' days')::interval - ((g % 86400) || ' seconds')::interval,
       now() - ((g % 730) || ' days')::interval
FROM generate_series(${lo}, ${hi}) g
ON CONFLICT (id) DO NOTHING;
SQL
  say "  stops ${lo}..${hi}"
  lo=$(( hi + 1 ))
done

# --- attempts --------------------------------------------------------------
# Attempt n hangs off stop (1 + (n-1) % STOPS), so the first pass gives every
# stop one attempt and the overflow gives the earliest stops a second. That is
# the real shape: most stops are attempted once, a minority more than once.
say "delivery attempts"
lo=1
while [ "$lo" -le "$ATTEMPTS" ]; do
  hi=$(( lo + CHUNK - 1 )); [ "$hi" -gt "$ATTEMPTS" ] && hi=$ATTEMPTS
  psql_remote <<SQL
INSERT INTO delivery_attempts
  (id, client_attempt_id, stop_id, driver_id, outcome, reason_code, neighbour_house_number,
   note, parcel_barcode, barcode_source, barcode_match, lat, lng, gps_accuracy_m,
   captured_at, received_at, app_version, source, declared_photo_count,
   evidence_status, payload_hash, updated_at)
SELECT ('00000002-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
       ('00000003-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
       ('00000000-0000-4000-8000-' || lpad(to_hex(1 + ((g - 1) % ${STOPS})), 12, '0'))::uuid,
       ('00000001-0000-4000-8000-' || lpad(to_hex(1 + (((g - 1) % ${STOPS}) % ${DRIVERS})), 12, '0'))::uuid,
       o.outcome,
       CASE WHEN o.outcome IN ('refused','access_failure')
            THEN (ARRAY['customer_refused','gate_locked','no_access_code'])[1 + (g % 3)] END,
       CASE WHEN o.outcome = 'left_with_neighbour' THEN (1 + (g % 90))::text END,
       CASE WHEN o.outcome = 'left_safe_place' THEN 'left round the back, gate was open' END,
       'JD' || lpad(((g::bigint * 7919) % 1000000000)::text, 10, '0'),
       (ARRAY['scanned','manual'])[1 + (g % 2)],
       (g % 97) <> 0,
       51.35 + ((g % 5000)::numeric / 10000),
       -0.35 + ((g % 7000)::numeric / 10000),
       4 + (g % 26),
       now() - ((g % 730) || ' days')::interval - ((g % 86400) || ' seconds')::interval,
       now() - ((g % 730) || ' days')::interval - ((g % 86400) || ' seconds')::interval + interval '4 seconds',
       '2.0.0',
       -- Not 'v2'. These rows never came through POST /api/v2/attempts and have
       -- no photographs behind them, so labelling them as captured evidence
       -- would be a lie told to every later query.
       'backfill',
       0,
       'complete',
       md5(g::text),
       now() - ((g % 730) || ' days')::interval
FROM generate_series(${lo}, ${hi}) g
CROSS JOIN LATERAL (
  SELECT (ARRAY['delivered_to_person','delivered_to_person','delivered_to_person',
                'left_safe_place','left_safe_place','left_with_neighbour',
                'no_answer_carded','access_failure','refused','delivered_to_person'])[1 + (g % 10)] AS outcome
) o
ON CONFLICT (id) DO NOTHING;
SQL
  say "  attempts ${lo}..${hi}"
  lo=$(( hi + 1 ))
done

say "ANALYZE"
psql_remote <<'SQL'
ANALYZE stops;
ANALYZE delivery_attempts;
ANALYZE drivers;
SQL

say "final counts"
psql_remote <<'SQL'
SELECT 'drivers            ' || count(*) FROM drivers;
SELECT 'stops              ' || count(*) FROM stops;
SELECT 'delivery_attempts  ' || count(*) FROM delivery_attempts;
SELECT 'demo round intact  ' || count(*)
  FROM stops s JOIN drivers d ON d.id = s.driver_id
 WHERE d.employee_ref = 'EMP-TEST-001' AND s.created_at >= date_trunc('day', now());
SQL
say "done"
