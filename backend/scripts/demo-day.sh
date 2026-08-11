#!/usr/bin/env bash
# Populates a believable delivery day through the real API, so the office
# dashboard shows actual work rather than an empty table (or, after a load
# test, tens of thousands of synthetic rows).
#
# Everything goes through the public write path: the same validation,
# idempotency, projection and AI summary generation a driver's handset gets.
#
# Usage: ./scripts/demo-day.sh [base-url]
set -euo pipefail

BASE="${1:-https://18.139.240.68.sslip.io}"
PASSWORD="TestDriver#2026"

uuid() { python3 -c "import uuid; print(uuid.uuid4())"; }

login() {
  curl -s -X POST "$BASE/api/v2/auth/driver/login" \
    -H 'Content-Type: application/json' \
    -d "{\"employeeRef\":\"$1\",\"password\":\"$PASSWORD\",\"deviceFingerprint\":\"demo-$1\",\"appVersion\":\"2.0.0\"}" |
    python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])"
}

# Real driver shorthand: terse, lowercase, occasionally misspelled. This is
# what the AI summary has to turn into something a customer can read.
NOTES=(
  "left round back by the green bin, gate was open, dog in garden"
  "handed to lady at door, signed"
  "no answer, card thru letterbox, tried twice"
  "left with neighbour at 42, they signed for it"
  "customer refused, said wrong item ordered"
  "gate locked, no access code, couldnt get in"
  "behind the wheelie bins under the porch out of rain"
  "left in porch, side door, safe and dry"
  "recipient signed, all good"
  "no answer 2nd attempt, carded again"
)

OUTCOMES=(
  "left_safe_place|photo"
  "delivered_to_person|signature"
  "no_answer_carded|photo"
  "left_with_neighbour|neighbour"
  "refused|reason"
  "access_failure|reason"
  "left_safe_place|photo"
  "left_safe_place|photo"
  "delivered_to_person|signature"
  "no_answer_carded|photo"
)

echo "==> Creating a demo delivery day against $BASE"
created=0

for driver_index in 0 1 2 3 4; do
  ref=$([ "$driver_index" -eq 0 ] && echo "EMP-TEST-001" || echo "EMP-$((1000 + driver_index))")
  token=$(login "$ref")
  stops=$(curl -s "$BASE/api/v2/stops" -H "Authorization: Bearer $token" |
    python3 -c "import sys,json; print(' '.join(s['id'] for s in json.load(sys.stdin)['stops'][:6]))")

  i=0
  for stop in $stops; do
    idx=$(((driver_index * 2 + i) % 10))
    note="${NOTES[$idx]}"
    IFS='|' read -r outcome kind <<<"${OUTCOMES[$idx]}"

    case "$kind" in
      photo) evidence='"photos":[{"index":0,"sizeBytes":420000}]' ;;
      signature) evidence='"signature":{"sizeBytes":80000}' ;;
      neighbour) evidence='"neighbourHouseNumber":"42","photos":[{"index":0,"sizeBytes":380000}]' ;;
      reason) evidence='"reasonCode":"Customer refused"' ;;
    esac
    [ "$outcome" = "access_failure" ] && evidence='"reasonCode":"Gate locked"'

    curl -s -o /dev/null -X POST "$BASE/api/v2/attempts" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      -d "{\"clientAttemptId\":\"$(uuid)\",\"stopId\":\"$stop\",\"outcome\":\"$outcome\",
           \"note\":\"$note\",\"lat\":51.5074,\"lng\":-0.1278,\"gpsAccuracyM\":8,
           \"capturedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"appVersion\":\"2.0.0\",
           \"parcelBarcode\":\"PCL-$RANDOM$RANDOM\",\"barcodeSource\":\"scanned\",$evidence}"
    created=$((created + 1))
    i=$((i + 1))
    sleep 0.3
  done
done

echo "==> Created $created attempts. Summaries generate asynchronously."
