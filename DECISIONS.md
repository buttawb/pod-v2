# DECISIONS

## Data model

**A new attempts table, not changes to pods.** `pods` allows one record per stop (`stop_id` UNIQUE); the brief needs many attempts with different evidence. `delivery_attempts` holds the truth, append-only; `pods` stays a live summary for the old app.

**The database itself blocks edits.** The app's user has no DELETE on evidence, and may UPDATE only bookkeeping columns (upload progress, signature verification, updated_at), never testimony. Corrections are new records.

**Outcomes are text with a CHECK, not an enum.** An enum can never remove a value and adding one fights transactional migrations; a CHECK gives the same protection with reversible SQL on a no-downtime system.

**Two clocks, kept.** `captured_at` is the phone's time at the door, `received_at` the server's on arrival; `clock_suspect` flags a phone claiming the future. Offline records arrive days late and phone clocks lie; a dispute needs both.

**GPS: honest, never blocking.** A failed fix is stored as null: a wrong location is worse evidence than none. Capture waits ~5 seconds; in time, stored with accuracy; late, discarded; the attempt saves regardless.

**Barcode: warn and record, never block.** A mismatch demands a reason; both codes stored. A blocked driver fakes an outcome; a recorded override beats a forced lie.

**Photo completeness is server-checked.** The client declares its files; the attempt stays `pending_media` until the server confirms each. The photo is the proof, so the server must know what it is owed.

## Offline and sync

**Evidence hits SQLite before any network call.**

**Sync is a chain of saved steps** (`draft -> queued -> submitting -> acked -> uploading_media -> synced`; `needs_attention` parks visibly). Each saves before the call it triggers, so force-quit costs at most one HTTP response; a start-up sweep resumes anything mid-way.

**Half-finished capture survives.** The form saves onto the draft row as it changes: a doorstep phone call must not lose a photo that cannot be retaken.

**Duplicates die by design.** The phone creates the attempt's ID; a unique rule in Postgres is the judge, so a resend gets 200 `deduplicated`; the same ID with different content gets 422, a bug to surface.

**Retries are limited and never silent.** Waits grow with jitter so phones do not retry together; after 8 tries the attempt parks visibly. Offline costs no retries: a basement is not failure.

**Two-phase visibility.** The attempt shows once its JSON lands; photos follow. "On server" means both confirmed; less says what is outstanding.

**The upload queue is scoped to the signed-in driver**, so on a shared handset the previous driver's unsent evidence waits for them, not the next driver's token.

**Login gates upload, never capture.** v2: a 7-day access token, 90-day rotating refresh; a reused refresh cancels that sign-in's family. v1 keeps its contractual 24 hours, so tuning v2 cannot log the old fleet out.

## Mid-day changes and conflicts

**Lists flow down, attempts flow up.** Adds and re-orders apply on sync; a withdrawn stop greys out unless it holds local work.

**Evidence always wins.** The server accepts an attempt whose stop was reassigned after capture and flags it at `/api/v2/conflicts`. An office edit at 14:00 does not undo a delivery made offline at 13:40.

**Carded and access-failure end the stop's day** unless the driver taps retry.

**Conflict resolution is designed, not built** (sanctioned); accept-and-flag is live.

## Migration (14M rows, 30% on v1.4.2, no window)

1. **Safety net.** Contract tests pin the frozen v1 surface (login `{email,password}`, 24h token, duplicate 409, stable `pods.created_at`), red first, then green.
2. **Expand.** Only add. Indexes build without locking; half-built leftovers dropped first, loud failure if any remain.
3. **Dual-write behind a flag.** One transaction writes the attempt, stop status and `pods` summary. Soak, watching v1 latency.
4. **Backfill.** 14M rows in batches of 1,000 with pauses; resumable and idempotent (IDs derive from the old rows); verified by counts, checksums, sampling.
5. **New reads for new surfaces only.** `GET /api/stops` stays on `pods`: moving a frozen read gains nothing and risks the contract.
6. **Sunset gate.** Removal starts only once v1 traffic is zero for a week.
7. **Remove, in order.** Flag off -> block writes -> 410 -> rename the table (instantly reversible) -> drop a release later. Step 1 is live; the rest designed, not built.

**The summary is ordered by the server clock**: a wrong phone date cannot freeze v1.

## Rollout and forced update

**Two levers.** `minAppVersion` gives grace on a saved timer and blocks at a 12-hour ceiling; a kill switch blocks at once when a build endangers evidence. Policy rides on API headers; a change lands at the next sync.

**Both block new captures only.** Uploading captured evidence is always allowed; losing proof costs more than any bug an update fixes.

**Depot rings.** Internal -> one depot -> 25% -> all, gated on crash-free rate.

## Performance

Measured same-region against the API on one `t3.small`: **p95 13.1ms**, flat to ~95 rps, knee at ~142 (p95 43ms), saturating near 200 with zero HTTP errors, a third of offered work turned away rather than failed. Steady state ~115 rps fits; bursts need three to four instances. It carries this because **photos never pass through the API**: the POST returns signed links, bytes go to S3, the server verifies each.

Depot map: the old design sent all ~5,000 stops (~850KB) and grouped them on the phone; the shipped one sends only the visible viewport, grouped in Postgres, the map engine drawing pins with no UI node per stop. The old design was not re-measured, so no multiple is claimed.

At **20M attempts, 14M stops** every read stays a selective index lookup and cursor pagination is flat: first page 2.4ms, 19M deep **0.38ms**, the tuple comparison becoming an index bound. Depot map, clustered country view: Exynos 2400e **p95 12ms, 5ms warm**, Helio G85 **p95 19ms, 15ms** against a 16.7ms budget, no missed vsync, and a cold start with no network renders the day from storage.

## Security, retention and erasure

**Photos have one door.** Private bucket; the database stores keys, not links; the only way in is an authenticated endpoint that checks the caller and issues a 300-second link.

**The AI provider gets the note text and outcome word only**, never an address, name, GPS or photo; a test asserts it against the outbound request.

**Retention is six years (confirmed).** Evidence is excluded from GDPR erasure under the legal-claims exemption (Art. 17(3)(e)), structurally: the app's role cannot delete it. Erasure wipes contact fields, cancels tokens, invalidates the credential, and logs field names only, never values.

**Found in self-audit:** an S3 lifecycle rule deleting evidence at 550 days against the 6-year duty, invisible because S3 does it itself; two demo scripts able to destroy real attempts, now locked down; a test approving a safe-place location leak as valid AI output, inverted; two migrations that had dropped the build-without-locking rule.

## What breaks at 100x

**Photos first**, projected rather than measured: signed links minted one at a time, and storage write limits per key path. Fix: batch the links, spread the keys, verify in background workers. **v1's full-history endpoint second:** unbounded by design for byte-compatibility, so statement timeouts are the first fix and retiring v1 is the real one. **Conflict review third:** the flag scales, the human process needs triage tools. **The pods summary:** a background job, or it dies with v1. **Not Postgres:** append-only inserts scale; split the table by month.

**The database is not on the app box**, so the obvious first ceiling is already gone: it is an Aurora Serverless v2 cluster on its own subnets, scaling on its own and backed up without anyone remembering. The instance stores nothing and is disposable.

## Deliberately not built, and assumptions

Office UI (client: read APIs, hit by curl). Conflict resolution workflow (sanctioned). Background sync: battery managers kill it, and the saved queue makes timing irrelevant. Day-list paging: a day is 120-180 stops, ~50KB, one fetch; paging adds offline failure modes to a non-problem. Edit or delete APIs on attempts: the absence is the feature. iOS, CI, push, route optimisation, admin CRUD. Offline map tiles: the offline promise is the work list; the map degrades honestly. Cross-day parcel history: a round is one day; redelivery is tomorrow's stop. Fleet-wide rate-limit counters (per identity, counted per instance in memory). Pool phones beyond queue scoping.

## AI tooling

**Used throughout, most usefully as an adversary.** Reviews found real defects: a retry path that silenced a device for a day, a committed Terraform plan leaking account details, a reload path that would have destroyed evidence on a re-run. Several rejected.

**Running it still beat reading it.** That reviewed script reported twelve tables loaded into an empty database: every `docker run -i` ate the shell's stdin, and the loop with it.

**Overrides.** IP-based rate limiting rejected: carriers put thousands of phones behind one IP, so sign-in is limited per account. A "fix" loosening a failing token test, rejected: one live token, never a self-inflicted logout.
