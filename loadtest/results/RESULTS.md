# Load test results

Measured 2026-08-11 against the deployed stack.

**Target:** one `t3.small` (2 vCPU, 2 GB) running two API containers and Caddy,
with the database on the same box at the time of this run. **Generator:** a
separate `t3.medium` in the same region, provisioned by the same Terraform
(`enable_loadtest_runner`).

> These numbers describe a smaller database on a different topology and are kept
> for the capacity arithmetic they support. The measurements that describe the
> deployed system are in "At 20 million rows" below.

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

**Zero HTTP errors at every level, including saturation.** Every request the
server was asked to answer, it answered. Latency degrades smoothly rather than
tipping into errors, which is the right failure mode for a courier app whose
alternative is a driver losing evidence.

Two things are true at saturation and they are worth separating, because
conflating them would overstate the result. The server shed no *requests*: the
error rate is 0% at 150/s just as it is at 25/s. But a third of the offered
*work* never became a request at all - 3,766 of roughly 11,500 iterations were
dropped by the generator, which in a constant-arrival-rate executor means it
could not allocate a VU in time because responses were taking 5.6s. So the
honest reading is: it queues rather than erroring, and past the knee the queue
grows faster than it drains. Work is still lost, just upstream of the server
and visibly rather than silently.

That distinction is why the open-model executor matters. A closed model would
have quietly slowed its own request rate to match the server, reported the
same zero errors, and hidden both the knee and the shed work.

## What this says about 3,000 drivers

| Quantity | Value |
|---|---|
| Required steady state (from the brief's numbers) | ~115 rps |
| One instance stays flat to | ~95 rps (p95 13.3ms) |
| Knee begins at | ~142 rps (p95 43ms) |
| One instance saturates around | ~200 rps (p95 5.6s) |

Note where ~115 rps falls: above the flat region and inside the knee, not
below both. Interpolating between the 95 and 142 rps rows puts p95 near
25-30ms at the required steady state, which is comfortable in absolute terms
for this workload. The fleet does fit on one instance; it does not fit in the
flat part of the curve, and those are different claims.

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

---

# At 20 million rows

Measured 2026-08-14 against the deployed system after loading a synthetic
history. Every number below comes from a command that was run; anything
reasoned rather than measured says so.

**Serving database:** Aurora PostgreSQL 16.14.0 Serverless v2 (0.5 to 16 ACU),
`ap-southeast-1`, on Graviton. **API:** unchanged, one `t3.small` running Caddy
and two API containers. The database is not on that box.

| Table | Rows | Total | Heap | Indexes |
|---|---|---|---|---|
| `delivery_attempts` | 20,050,681 | 11 GB | 5,226 MB | 5,827 MB |
| `stops` | 14,008,320 | 12 GB | 4,440 MB | 7,698 MB |
| `attempt_photos` | 50,549 | 13 MB | 8,760 kB | 4,576 kB |

Index sizes on the two large tables. The two 8 kB entries are partial indexes,
which is the `WHERE` clause doing its job rather than an error:

| Index | Size |
|---|---|
| `idx_stops_driver_updated` | 2,504 MB |
| `idx_stops_geo` (GiST) | 1,959 MB |
| `idx_stops_created_at` | 1,413 MB |
| `idx_attempts_stop` | 1,392 MB |
| `idx_attempts_driver_updated` | 1,356 MB |
| `delivery_attempts_pkey` | 1,085 MB |
| `uq_attempts_client_attempt_id` | 1,085 MB |
| `idx_stops_driver_day` | 1,063 MB |
| `idx_attempts_received_keyset` | 909 MB |
| `stops_pkey` | 759 MB |
| `idx_attempts_conflict` (partial) | 8,192 bytes |
| `idx_attempts_retry_today` (partial) | 8,192 bytes |

## Endpoint latency

Measured over 12 calls each, from a laptop in Karachi against Singapore. **The
network and TLS baseline is 325 ms p50** (`/api/health`, which does no database
work), so subtract that to read server time. The absolute numbers are dominated
by intercontinental round trip and are not a server measurement.

| Endpoint | Surface | p50 | p95 | Server time, approx |
|---|---|---|---|---|
| `GET /api/v2/stops` | v2 | 539.5 ms | 590.7 ms | ~214 ms |
| `GET /api/v2/stops/{id}` | v2 | 288.7 ms | 405.1 ms | ~0 ms |
| `GET /api/v2/sync` | v2 | 761.9 ms | 1057.9 ms | ~437 ms |
| `GET /api/v2/depot/stops.geojson` | v2 | 579.2 ms | 634.9 ms | ~254 ms |
| `GET /api/v2/office/attempts` | v2 office | 386.0 ms | 444.4 ms | ~61 ms |
| `GET /api/v2/office/stats` | v2 office | 360.4 ms | 438.8 ms | ~35 ms |
| `GET /api/v2/office/conflicts` | v2 office | 319.1 ms | 359.2 ms | ~0 ms |
| `GET /api/v2/conflicts` | v2 | 310.4 ms | 354.8 ms | ~0 ms |
| `GET /api/stops` | v1 frozen | 609.3 ms | 708.6 ms | ~284 ms |

## Query plans

`EXPLAIN (ANALYZE, BUFFERS)` against the 20M table. Every read stayed a
selective index lookup; none turned into a sequential scan.

| Read | Plan | Time | Buffers |
|---|---|---|---|
| Driver's round for today | Index Scan `idx_stops_driver_day` | 0.298 ms | 152 |
| Attempts for one stop | Index Scan `idx_attempts_stop` | 1.455 ms | 8 |
| Office keyset page, first | Index Scan `idx_attempts_received_keyset` | 1.597 ms | 53 |
| Office keyset page, 10M deep | Index Scan `idx_attempts_received_keyset` | 0.173 ms | 53 |
| Conflicts list | Index Scan `idx_attempts_conflict` (partial) | 0.016 ms | 1 |
| Latest attempt per stop | Index Scan `idx_attempts_stop` + top-N heapsort | 1.034 ms | 21 |
| Dashboard stats, stops today | Index Only Scan `idx_stops_created_at` | 5.3 ms | 10,474 |

The office keyset page shows **no Incremental Sort**, which is what migration
`1755000000013-AttemptsReceivedTieOrder` was for: the index tie-order
`(received_at DESC, id DESC)` matches the cursor comparison exactly. Confirmed
still true at 20 million.

## Cursor pagination, deep and random

Keyset pagination pages from a cursor rather than jumping to a page number, so
it was tested by sampling cursors at increasing depth through the full 20
million and paging from each.

| Cursor position | Page time |
|---|---|
| First page, newest, no cursor | 2.366 ms |
| 1,000,000 rows deep | 0.680 ms |
| 5,000,000 rows deep | 0.447 ms |
| 10,000,000 rows deep | 0.423 ms |
| 15,000,000 rows deep | 0.385 ms |
| 19,000,000 rows deep | 0.379 ms |

**Flat, and the deep pages are faster than the first**, because the first page
pays query planning and colder buffers while the rest hit a warm index. Depth
costs nothing: the tuple comparison `(received_at, id) < ($1, $2)` becomes an
index bound rather than a filter, so the scan starts at the cursor instead of
counting up to it.

For contrast, building those cursors with `OFFSET` took **25,017 ms**, because
`OFFSET` reads and discards every row it skips. That is the cost keyset
pagination exists to avoid, and it is why the office lists do not offer a page
number.

**No `OFFSET` in any list read.** Verified by grep across `backend/src/modules`:
zero occurrences of `OFFSET`, `.offset(`, or `skip(` outside tests.

## Two things investigated

**The depot map looked like a hang, and was not.** The first sweep recorded p95
**30,005 ms**, which was the 30 second client timeout. Over 25 further calls:
p50 579.2 ms, p95 634.9 ms, max 638.8 ms, **zero calls over 2 seconds**. It was
a single cold-start outlier on the first request after a deploy: new containers,
an empty connection pool, and cold buffers on a 1,959 MB GiST index. The index
is genuinely used: `idx_stops_geo` went from 0 to 42 scans across these calls.
Reasoned, not proven: the cold path is the explanation that fits, but it was not
reproduced deliberately.

**The dashboard stats query does not reach zero heap fetches.** It uses
`Index Only Scan using idx_stops_created_at` as intended, but reports
**Heap Fetches: 5,076** for 10,715 rows. One fix was attempted, a
`VACUUM (ANALYZE) stops`, which moved it from 5,107 to 5,076: no change worth
the name. It was not pursued further.

The explanation is that those rows are today's stops, which are the rows the
demo roll and the round reset had just written. A visibility map cannot mark
pages all-visible while their tuples are still that new, so the heap check is
unavoidable for hot rows and no index change removes it. At 5.3 ms across a
14M-row table this is not a problem, and it is recorded here because the
prediction was zero and the measurement was not.

**No migration was shipped.** Nothing found met the bar for one.

## Next lever, if this grows again

Range partition `delivery_attempts` by month on `received_at`. The keyset reads
already only touch the newest partition, so pruning would cut index size per
query rather than change the access pattern. Not needed at 20 million: the
measurements above show no depth penalty and no sequential scans.

## Device performance

Capture commands, so the two passes are identical:

```bash
adb shell dumpsys gfxinfo com.podv2.driver reset
# drive the scripted camera tour, then:
adb shell dumpsys gfxinfo com.podv2.driver framestats
adb shell dumpsys meminfo com.podv2.driver
```

| | Low end: Xiaomi Redmi 13C | Flagship: Samsung S24 FE |
|---|---|---|
| Model | `23106RN0DA` | `SM-S721B` |
| Android | 15 (SDK 35) | 16 |
| Chipset | MediaTek Helio G85 (MT6769V/CZ) | to follow |
| RAM | 5,797,220 kB (5.5 GiB) | to follow |
| Screen | 720x1600 @ 320 dpi | to follow |
| Depot map p50 frame time | **6 ms** / 6 ms | to follow |
| Depot map p90 frame time | 8 ms / 8 ms | to follow |
| Depot map p95 frame time | **9 ms** / 9 ms | to follow |
| Depot map p99 frame time | 16 ms / 18 ms | to follow |
| Janky frames | **0.76%** / 1.51% | to follow |
| Janky frames (legacy metric) | 3.04% / 2.59% | to follow |
| Missed vsync | 0 / 0 | to follow |
| GPU p95 | 2 ms | to follow |
| Frames rendered | 526 / 464 | to follow |
| PSS after tour | **291 MB** / 330 MB | to follow |
| RSS after tour | 450 MB / 490 MB | to follow |
| PSS at sign-in, before any map | 119 MB | to follow |

Two runs of the same scripted tour, reported as `run 1 / run 2`.

**The budget phone holds 60 fps.** The frame budget at 60 Hz is 16.7 ms and the
p95 is 9 ms, with zero missed vsyncs across 990 frames. That is a MediaTek Helio
G85 rendering the depot map while the API behind it answers from a 20 million
row table.

Worth noting against the earlier Samsung S24 FE figures in DECISIONS.md (p95
7 ms, jank 1.1 to 2.5%, 465 to 479 MB PSS): the low end phone shows *lower* jank
and *less* memory. That is not the budget device outperforming the flagship. It
is a 720x1600 screen having roughly a third of the pixels to push and a smaller
tile cache to hold, which is exactly why both numbers are reported rather than
one being taken as the device story.

PSS grew 291 MB to 330 MB between the two runs, which is map tile cache filling
and is expected.

### Functional checks on the low end device

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Install release APK 2.0.0 | PASS | `adb install` Success after enabling MIUI "Install via USB" |
| 2 | Cold launch to sign-in | PASS | renders in under 12 s, version 2.0.0 shown |
| 3 | Sign in against the 20M backend | PASS | list reads "42 of 151 done, 109 left", matching the server exactly |
| 4 | Depot map opens and draws pins | PASS | opens on current location (Karachi), status filter chips present |
| 5 | **Cold start fully offline** | **PASS** | wifi and data disabled, `ping` reports network unreachable, app cold-launches and renders the full 151 stop day from device storage with an explicit Offline banner |

The remaining functional items in the device plan (the six outcomes and their
evidence rules, the photo cap, barcode mismatch, force quit mid capture and mid
submit, retry backoff, live status) were not run in this pass and are not
claimed.
