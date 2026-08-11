# DECISIONS

## Data model

An **attempt** is the unit, not a delivery. `delivery_attempts` is append-only:
many attempts per stop, six outcomes, and evidence rules living in one module
(`src/domain/outcomes.ts`) that DTO validation, service checks and DB `CHECK`
constraints all derive from. Outcomes are `text` with check constraints, not
Postgres enums: `ALTER TYPE ADD VALUE` cannot run in a transactional migration
and values can never be dropped, a one-way door on a system that must never
take a maintenance window.

Two clocks are recorded, neither overwriting the other: `captured_at` from the
handset, `received_at` from the server, plus a `clock_suspect` flag. A device
can submit Tuesday's attempt on Thursday and a dispute needs both. GPS is typed
columns with accuracy, not v1's `"51.5,-0.1"` string: a 5m fix and a 2000m fix
are very different evidence.

Completeness is explicit: the client declares its media at submit, the server
writes one `attempt_photos` row per declared file, and the attempt sits in
`pending_media` until the server has verified every object itself via
`HeadObject`. "The photo IS the proof" means the server must know what it is
owed, so an attempt missing a photo is visibly incomplete rather than passing
as full proof.

## Offline and sync

The device database is the system of record until the server says otherwise:
evidence hits disk **before** any network call, every call is idempotent, and
the UI never claims more than the server confirmed.

Sync is a state machine over durable SQLite rows (WAL): `draft -> queued ->
submitting -> attempt_acked -> uploading_media -> synced`, with
`needs_attention` as a parked state never auto-cleared. Transitions persist
before the network call they enable, so a force-quit costs at most one HTTP
response, never evidence. A cold-start sweep re-queues anything caught
mid-flight and turns anomalies (a missing evidence file) into a visible row,
never a silent skip.

**Duplicates** are handled by construction. The client mints
`client_attempt_id` at capture and never changes it; a Postgres unique index is
the arbiter across instances, so no in-process state is involved. A replay with
the same payload hash returns 200 `deduplicated: true`; a *different* payload
returns 422, because same key with different data is a client bug that must
surface. Deterministic S3 keys make a re-upload overwrite identical bytes
rather than duplicate.

**Failure modes.** One classifier separates retryable (network, timeout, 5xx,
429) from permanent (4xx), with full-jitter backoff capped at 300s and 8
retries before an attempt is parked for the driver. Being offline burns no
retry budget: a basement is not a failure. Retrying a validation error forever
is the definition of a poison message, so those park immediately with the
server's own message and the reassurance that everything is still on the
phone.

Sync is foreground-only: Android background execution is throttled by OEM
battery managers and killed by force-quit, the exact failure mode being
defended against. The durable queue makes timing irrelevant, so this changes
*when* evidence uploads, never *whether*.

## Migration plan

Expand/contract, with a flag as the rollback lever at every stage.

1. **Safety net.** Shape-pinned contract tests for both v1 endpoints in CI.
2. **Expand.** Additive DDL only. Constant defaults are metadata-only in
   PG11+, so no rewrite of a 14M-row table. Indexes build `CONCURRENTLY`
   outside a transaction, dropping INVALID leftovers first, then fail loudly
   if any remain: an invalid unique index enforces nothing while the deploy
   reports success.
3. **Dual-write** behind `DUAL_WRITE_PODS`. Both write paths go through one
   service that inserts the attempt, updates `stops.status` and upserts `pods`
   in one transaction. Soak, watching v1 latency.
4. **Backfill** 14M `pods` rows: a checkpointed script, keyset over
   `(created_at, id)` with no OFFSET, batches of 5,000 with a sleep between,
   idempotent via `uuidv5(pod.id)` + `ON CONFLICT DO NOTHING`, verified by
   per-day counts, checksums and a sample diff. No rollback needed: additive
   to a table no v1 reader touches, and re-runs upsert cleanly.
5. **Read cutover** for new surfaces only. `GET /api/stops` stays on `pods`:
   migrating a frozen client's read path gains nothing and risks the contract.
6. **Sunset gate.** Contract begins only after v1.4.2 traffic has been zero for
   seven consecutive days. Traffic data, not the calendar.
7. **Contract**, in order: flag off dual-write -> `REVOKE` writes on `pods` (a
   loud tripwire) -> `410 Gone` -> rename the table (instantly reversible) ->
   drop, one release later. DDL drops go last: they are the only step that
   cannot be undone in seconds.

`pods` becomes a projection of the latest attempt by `captured_at`, clamped to
the server clock so a handset with a wrong future date cannot pin itself as
"latest" and freeze what v1 clients see. It is application-layer, not a trigger,
so the mapping is unit-tested, reviewable and flag-disableable.

## Rollout and forced update

Two levers, two severities. `minAppVersion` means "must update, humanely": a
driver mid-route enters grace, with a persisted clock so relaunching cannot
dodge it, and is blocked only at route completion or a 12-hour ceiling.
`blockedVersions` is a kill switch that blocks immediately, accepting
operational damage because a build that corrupts evidence is worse. Policy
rides on **every** API response as headers, so a mid-shift change lands at the
next sync, not the next poll.

Both levers block *new captures only*: uploading already-captured evidence is
always allowed and the block screen drives sync itself. Stranding proof costs
more than any bug an update fixes, and a driver who fears losing work will
dodge updates entirely.

Rollout is by depot ring (internal -> one depot -> 25% -> rest), gated on
crash-free rate, submission failures and photo upload success; rollback lowers
the minimum and republishes the previous build. The 30% on v1.4.2 sit in later
rings against the compat API, with `X-App-Version` telemetry as the straggler
list.

## Performance

Measured from a same-region EC2, not a laptop: the first run reported p95
508ms and was measuring my broadband, while the runner showed **p95 13.1ms**.
One `t3.small` with Postgres co-located stays flat to ~142 rps, degrades from
~170, and saturates near 200, with **zero errors at every level**: it queues
rather than sheds, the right failure mode here. The brief's 3,000 drivers
compute to ~115 rps steady state, so the fleet fits on one instance with
headroom; the morning burst needs three to four. Numbers in
`loadtest/results/RESULTS.md`.

The depot map ships three render modes behind an env flag (per-stop markers,
unclustered symbols, clustered GPU layers) plus a scripted camera tour, so
before/after numbers come from an identical workload. The shipped design puts
all ~5,000 stops in one GeoJSON source rendered by GPU style layers with zero
React components per stop, and filtering swaps a layer filter expression
rather than re-uploading the payload. **I have not captured the frame-time
table on hardware**, so no numbers are claimed: the harness and method are in
the repo, and estimates would be exactly the guessing this section rules out.

## What breaks at 100x

Unbounded queries first: v1's full-history endpoint is already the canary at
14M rows, so finishing the sunset and adding statement timeouts leads. Then
partition `delivery_attempts` by month on `received_at`, moving idempotency to
an unpartitioned sidecar (a partitioned unique constraint must include the
partition key); the schema was shaped so this is re-plumbing, not redesign.
Then an archive tier keeping ~6 hot months. Photo storage becomes the real
bill, handled by S3 lifecycle tiering. On this box, Postgres and the API share
two vCPUs, so splitting the database off comes first.

## What I deliberately did not build

iOS. Background sync (justified above). Push notifications. Route
optimisation. Admin CRUD. A customer-messaging channel: the AI summary stops
at a human-approved draft. Observability beyond structured logs and health
checks. Multi-depot modelling. ABI-split APKs: the universal build is 147MB,
chosen over a smaller file that might not run on a reviewer's machine.

## Assumptions

No questions could be asked, so these are documented calls. Office sees attempt
status, **not** driver GPS traces: employee movement is the most sensitive data
here and the brief asks for delivery status. The v1 response shape is derived
from the given schema and frozen as tests. Barcode mismatch warns, never
blocks. Summaries are drafted, not sent. Retention is 18 months (`PRIVACY.md`).

## AI tooling

Used throughout, most valuably as an adversary rather than an author: review
passes over my own code found 16 real defects, three critical (a retry path
that stopped a device syncing for a whole day, a stale in-memory state that
left verified evidence stuck "uploading", and a photo index that overwrote
captured evidence). Each was verified against the code before I acted, and
several suggestions were rejected.

Where I overrode it: it accepted IP-based rate limiting, wrong when carriers
NAT thousands of subscribers behind one address, and per-IP login limits, which
would throttle a depot signing in together; sign-in is now bounded by the
account being attempted. It also proposed "fixing" a failing concurrent-refresh
test by loosening the assertion, when the honest fix was to state the real
invariant, one live token and never a self-inflicted logout, and pin that.
