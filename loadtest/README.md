# Load tests

k6 scenarios that put a number on the brief's "what happens at 3,000
concurrent drivers rather than one".

## The arithmetic being tested

| Quantity | Working |
|---|---|
| Attempts per day | 3,000 drivers x 150 stops = 450,000 |
| Sustained attempt rate | 450,000 / 8h = **~15.6/s** |
| Requests per attempt | submit + presign + finalize = ~3.4 |
| Attempt-path RPS | ~53 |
| Plus route pulls, sync, config polls | **~115 rps steady state** |
| Morning burst (06:30-08:00) | ~4-6x the attempt path = **~400-500 rps peak** |

## Scenarios

| File | Executor | What it proves |
|---|---|---|
| `morning-burst.js` | ramping-vus to 300 | Login + route pull + submit under a rising fleet, with 10% deliberate idempotency-key replays that must all come back deduplicated |
| `steady-day.js` | constant-arrival-rate (open model) | Sustained throughput. Arrivals do not slow when the server does, so degradation appears as a p95 blowout rather than silently reduced load |

## Running

```bash
brew install k6
k6 run loadtest/k6/steady-day.js
RATE=120 DURATION=10m k6 run loadtest/k6/steady-day.js
k6 run loadtest/k6/morning-burst.js
```

Run from a machine that is **not** the API host, and watch the generator's
own CPU: above roughly 70% the numbers measure k6, not the server.

## Post-run correctness check

Latency means nothing if the writes were wrong. After a run, exactly one
row must exist per idempotency key:

```sql
SELECT count(*) AS duplicate_keys FROM (
  SELECT client_attempt_id FROM delivery_attempts
  GROUP BY client_attempt_id HAVING count(*) > 1
) dupes;
```

## Honesty notes for DECISIONS.md

- One generator machine measures **server capacity**, not client realism:
  no geographic RTT spread, no 3,000 genuine TLS profiles.
- The API host is a t3.small with Postgres co-located, and t3 is
  burstable: a long run can exhaust CPU credits and collapse throughput
  for reasons unrelated to the code. Watch `CPUCreditBalance` and say so.
- Claims are therefore stated **per instance**, with the arithmetic shown.
  The API tier is stateless behind the load balancer, so it scales
  horizontally; Postgres is the real ceiling.
