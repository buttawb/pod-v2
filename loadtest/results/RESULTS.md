# Results

Two measurement passes against the deployed system. Every number here came from
a command that was run; anything reasoned rather than measured says so.

- **API**: one `t3.small` in `ap-southeast-1` running Caddy and two API containers.
- **Database**: Aurora PostgreSQL 16.14 Serverless v2 (0.5 to 16 ACU), on its own.
- **Generator** (load test): a separate same-region `t3.medium`.

---

## 1. Capacity

`steady-day.js`, open model. One iteration is an attempt submission plus an
upload-URL request, so **1 iteration = 2 HTTP requests**.

| Target | Achieved | Requests/s | p95 | Errors |
|---|---|---|---|---|
| 25/s | 24.5/s | ~49 | **13.1 ms** | 0% |
| 50/s | 47.3/s | ~95 | **13.3 ms** | 0% |
| 75/s | 71.0/s | ~142 | **43 ms** | 0% |
| 90/s | 84.9/s | ~170 | **320 ms** | 0% |
| 150/s | 101/s | ~202 | **5.6 s** | 0% |

**Zero HTTP errors at every level, including saturation.** Latency degrades
smoothly rather than tipping into errors, which is the right failure mode for a
courier app whose alternative is a driver losing evidence.

Two things are true at saturation and conflating them would overstate the
result. The server shed no *requests*. But a third of the offered *work* never
became a request: 3,766 of ~11,500 iterations were dropped by the generator,
because in a constant-arrival-rate executor it could not allocate a VU in time.
So it queues rather than erroring, and past the knee the queue grows faster than
it drains. Work is still lost, just upstream and visibly.

**Against the brief's 3,000 drivers:** required steady state is ~115 rps. One
instance is flat to ~95 rps and the knee is ~142, so 115 rps sits inside the
knee, not below it. Interpolating puts p95 near 25-30 ms there. The fleet fits
on one instance; it does not fit in the flat part of the curve, and those are
different claims. The morning burst (~400-500 rps) needs three to four
instances, which is a horizontal problem: the API tier is stateless, idempotency
is arbitrated by a unique index in Postgres rather than in process memory, and
the SSE feed fans out through LISTEN/NOTIFY.

---

## 2. Reads at 20 million rows

`delivery_attempts` **20,050,681** rows / 11 GB. `stops` **14,008,320** / 12 GB.

### Cursor pagination is flat

The headline. Cursors sampled at increasing depth through the full 20 million:

| Cursor depth | Page time |
|---|---|
| First page (newest) | 2.366 ms |
| 1,000,000 deep | 0.680 ms |
| 5,000,000 deep | 0.447 ms |
| 10,000,000 deep | 0.423 ms |
| 19,000,000 deep | **0.379 ms** |

Deep pages are *faster* than the first, which pays planning and colder buffers.
Depth costs nothing because the tuple comparison `(received_at, id) < ($1, $2)`
becomes an index bound, so the scan starts at the cursor instead of counting up
to it. Building those same cursors with `OFFSET` took **25,017 ms**, which is
the cost being avoided. **No `OFFSET` in any list read**, verified by grep.

### Query plans

Every read stayed a selective index lookup. None became a sequential scan.

| Read | Plan | Time |
|---|---|---|
| Driver's round for today | Index Scan `idx_stops_driver_day` | 0.298 ms |
| Attempts for one stop | Index Scan `idx_attempts_stop` | 1.455 ms |
| Office keyset page | Index Scan `idx_attempts_received_keyset` | 1.597 ms |
| Conflicts list | Index Scan `idx_attempts_conflict` (partial) | 0.016 ms |
| Latest attempt per stop | Index Scan + top-N heapsort | 1.034 ms |
| Dashboard stats | Index Only Scan `idx_stops_created_at` | 5.3 ms |

The office keyset page shows **no Incremental Sort**, which is what the
`(received_at DESC, id DESC)` tie-order index was for, still holding at 20M.

### Endpoint latency

Measured from a laptop in Karachi against Singapore, 12 calls each. **The
network and TLS baseline is 325 ms p50** (`/api/health`, no database work), so
subtract it. These are dominated by intercontinental round trip.

| Endpoint | p50 | p95 |
|---|---|---|
| `GET /api/v2/stops` | 539 ms | 591 ms |
| `GET /api/v2/stops/{id}` | 289 ms | 405 ms |
| `GET /api/v2/depot/stops.geojson` | 579 ms | 635 ms |
| `GET /api/v2/office/attempts` | 386 ms | 444 ms |
| `GET /api/stops` (v1, unbounded) | 609 ms | 709 ms |

### Two things found, neither fixed

**The depot map's 30 second p95 was a cold start**, not a hang. Over 25 further
calls: p50 579 ms, max 639 ms, zero over 2 seconds. First request after a
deploy, on cold buffers over a 1,959 MB GiST index.

**The stats query does not reach zero heap fetches.** It reports 5,076 for
10,715 rows while correctly choosing an Index Only Scan. A `VACUUM (ANALYZE)`
moved it to 5,076 from 5,107, which is not a fix, so it was not pursued. Those
rows are today's stops, the ones just written, and a visibility map cannot mark
pages all-visible while their tuples are that new. At 5.3 ms over a 14M row
table this is not a problem. It is recorded because the expectation was zero.

**No migration shipped.** Nothing found met the bar.

**Next lever if this grows:** range partition `delivery_attempts` by month on
`received_at`. Not needed at 20 million.

---

## 3. Devices

Depot map, clustered country view over 5,000 stops, scripted camera tour, two
runs reported as `run 1 / run 2`.

```bash
adb shell dumpsys gfxinfo com.podv2.driver reset
# 3x (4 swipes + tap + 2 diagonal swipes), ~30s
adb shell dumpsys gfxinfo com.podv2.driver
adb shell dumpsys meminfo com.podv2.driver
```

| | Samsung S24 FE | Xiaomi Redmi 13C |
|---|---|---|
| Chipset | Exynos 2400e | MediaTek Helio G85 |
| RAM / screen | 7.1 GiB, 1080x2340 | 5.5 GiB, 720x1600 |
| p50 frame | 5 / 5 ms | **8 / 8 ms** |
| p95 frame | **12 / 5 ms** | **19 / 15 ms** |
| Janky frames | 1.28% / 0.95% | **5.12% / 4.43%** |
| Missed vsync | 0 / 0 | **0 / 0** |
| GPU p95 | 10 / 2 ms | 3 / 3 ms |
| PSS after tour | 430 / 462 MB | 298 / 298 MB |

**Both hold interactive frame rates against a 20 million row backend.** The
budget phone sits at the edge of the 16.7 ms budget rather than inside it: its
p95 lands late, its median does not, and neither device missed a vsync across
1,707 and 418 frames respectively. Jank on the Redmi is four to five times the
flagship's, which is the honest answer to where the low end hurts.

Two details worth keeping. GPU time is not the constraint on either device, so
the cost is UI thread work rather than rasterising pins. And memory runs
backwards from intuition: the budget phone holds less and stays flat, because a
720x1600 screen caches a third of the tile pixels.

**Offline cold start passed** on both: wifi and data disabled, `ping` reporting
the network unreachable, and the app cold-launches rendering the full 151 stop
day from device storage behind an explicit Offline banner.

An earlier set of numbers for both handsets was withdrawn before publication.
The depot map opens on the depot, both phones were in Karachi, and the coverage
was London, so the viewport held 12 stops and the measurement described an empty
screen. The tell was memory: 331 MB against 465 to 479 MB recorded for the same
handset previously. The table above is the re-measurement after seeding
coverage the phones could actually see.

**Not run, and not claimed:** the six outcomes and their evidence rules, the
photo cap, barcode mismatch, force quit mid capture and mid submit, retry
backoff, and live status.

---

## Honesty notes

- One generator measures **server capacity**, not client realism: no geographic
  RTT spread, no 3,000 distinct TLS profiles.
- `t3` is burstable. Runs stayed inside the credit balance; sustained production
  load would need T3 Unlimited or a non-burstable class.
- Rate limiting is per authenticated identity, so the generator spreads across
  all seeded drivers. A single-token run measures the rate limiter, not
  capacity, which is exactly what the first attempt did.
- The capacity numbers in section 1 were taken before the database moved to its
  own cluster. They are kept for the arithmetic they support, not as a
  description of today's topology.
