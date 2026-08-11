# Load test results

Measured 2026-08-11 against the deployed stack.

**Target:** one `t3.small` (2 vCPU, 2 GB) running two API containers, Postgres,
and Caddy, all co-located. **Generator:** a separate `t3.medium` in the same
region, provisioned by the same Terraform (`enable_loadtest_runner`).

Each iteration is a real attempt submission plus an upload-URL request, so
**1 iteration = 2 HTTP requests**.

## Why the generator location mattered

The first run came from a laptop in Karachi against Singapore:

| Generator | Median | p95 | Verdict |
|---|---|---|---|
| Laptop (Karachi to Singapore) | 116ms | **508ms** | Measures my broadband |
| EC2, same region | 10.5ms | **13.1ms** | Measures the server |

Warm connection setup from the runner is 2ms TCP, 27ms including TLS. The
laptop's 508ms p95 was almost entirely wide-area network. Numbers below are
all from the same-region runner.

## Capacity curve (`steady-day.js`, open model)

| Target rate | Achieved | Requests/s | p95 | Errors | Notes |
|---|---|---|---|---|---|
| 25/s | 24.5/s | ~49 | **13.1ms** | 0% | Comfortable |
| 50/s | 47.3/s | ~95 | **13.3ms** | 0% | Still flat |
| 75/s | 71.0/s | ~142 | **43ms** | 0% | Knee begins |
| 90/s | 84.9/s | ~170 | **320ms** | 0% | Degrading |
| 150/s | 101/s | ~202 | **5.6s** | 0% | Saturated, 3,766 iterations dropped |

Per-endpoint at the 25/s baseline: attempt submit p95 **14.2ms**, presign p95
**7.8ms**. Checks passed 9,035 out of 9,035.

**Zero HTTP errors at every level, including saturation.** The service queues
rather than sheds: latency degrades smoothly and requests still succeed. That
is the right failure mode for a courier app whose alternative is a driver
losing evidence, and it is why the open-model executor matters - a closed
model would have quietly slowed its own request rate and hidden the knee.

## What this says about 3,000 drivers

| Quantity | Value |
|---|---|
| Required steady state (from the brief's numbers) | ~115 rps |
| One instance sustains comfortably | ~142 rps |
| One instance saturates around | ~200 rps |

So the entire 3,000-driver steady state fits on a single `t3.small` with
headroom to spare. The morning burst (~400-500 rps) needs roughly three to
four instances, which is a horizontal-scaling problem: the API tier is
stateless, idempotency is arbitrated by a unique index in Postgres rather
than by anything in process memory, and the SSE feed fans out through
Postgres LISTEN/NOTIFY, so every instance sees every event.

## What breaks first

Postgres and the API compete for the same two vCPUs on this box, so CPU is
the first ceiling. Splitting the database onto its own instance is the first
move, and the schema is ready for it: no local state, no sticky sessions.
The photo path never enters this equation at all, because bytes go straight
from the handset to S3 on presigned URLs - the API only signs and verifies.

## Honesty notes

- One generator machine measures **server capacity**, not client realism.
  There is no geographic RTT spread and no 3,000 distinct TLS profiles.
- `t3` instances are burstable. Runs here were short enough to stay inside
  the credit balance, but a sustained production load would need `T3
  Unlimited` or a non-burstable class.
- Rate limiting is tracked per authenticated identity, so the generator
  spreads across all 33 seeded drivers. A single-token run measures the
  rate limiter, not capacity - which is exactly what the first attempt did.
