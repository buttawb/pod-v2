# DECISIONS

## Data model

**A new attempts table, not changes to pods.** `pods` allows one record per stop (`stop_id` UNIQUE); the brief needs many attempts with different evidence. `delivery_attempts` holds the truth, append-only; `pods` stays a live summary of the latest attempt for the old app.

**The database itself blocks edits.** The app's database user has no DELETE on evidence, and may UPDATE only bookkeeping columns (upload progress, signature verification, updated_at), never testimony. Corrections are new records.

**Outcomes are text with a CHECK rule, not an enum.** A Postgres enum can never remove a value and adding one fights transactional migrations; a CHECK gives the same protection with reversible SQL on a no-downtime system.

**Two clocks, kept.** `captured_at` is the phone's time at the door; `received_at` is the server's time on arrival; `clock_suspect` flags a phone claiming the future. Offline records arrive days late and phone clocks lie; a dispute needs both.

**GPS: honest, never blocking.** A failed fix is stored as null: a wrong location is worse evidence than none. Capture waits ~5 seconds; in time, stored with accuracy; late, discarded; either way the attempt saves.

**Barcode: warn and record, never block.** A mismatch demands a reason; both codes stored. A blocked offline driver fakes an outcome; a recorded override beats a forced lie.

**Photo completeness is server-checked.** The client declares its files; the attempt stays `pending_media` until the server confirms each exists. The photo is the proof, so the server must know what it is owed.

## Offline and sync

**Evidence hits SQLite before any network call.**

**Sync is a chain of saved steps** (`draft -> queued -> submitting -> acked -> uploading_media -> synced`; `needs_attention` parks visibly). Each step saves before the call it triggers, so force-quit costs at most one HTTP response; a start-up sweep resumes anything mid-way.

**Half-finished capture survives too.** The form saves onto the draft row as it changes: a doorstep phone call must not lose a photo that cannot be retaken.

**Duplicates die by design.** The phone creates the attempt's ID; a unique rule in Postgres is the judge, so a resend gets 200 `deduplicated`; the same ID with different content gets 422, a bug to surface, not a retry.

**Retries are limited and never silent.** Waits grow with randomness so phones do not retry together; after 8 tries the attempt parks visibly. Being offline costs no retries: a basement is not a failure.

**Two-phase visibility.** The attempt shows once its JSON lands; photos follow. "On server" means both confirmed; anything less says what is outstanding.

**The upload queue is scoped to the signed-in driver**, so on a shared handset the previous driver's unsent evidence waits for them rather than uploading under the next driver's token.

**Login gates upload, never capture.** v2: a 7-day access token with a 90-day rotating refresh; a reused refresh token cancels that sign-in's family. v1 keeps its contractual 24 hours, so tuning v2 cannot log the old fleet out.

## Mid-day changes and conflicts

**Lists flow down, attempts flow up.** Adds and re-orders apply on sync; a withdrawn stop greys out unless it has local work, which stays visible.

**Evidence always wins.** The server accepts an attempt whose stop was reassigned after capture and flags it, read-only at `/api/v2/conflicts`. An office edit at 14:00 does not undo a delivery made offline at 13:40.

**Carded and access-failure end the stop's day** unless the driver taps retry-today.

**Conflict resolution is designed, not built** (sanctioned); accept-and-flag is live.

## Migration (14M rows, 30% on v1.4.2, no window)

1. **Safety net.** Contract tests pin the frozen v1 surface (login `{email,password}`, 24h token, duplicate 409, stable `pods.created_at`). Red state captured by curl against the live API, fixed, re-checked green.
2. **Expand.** Only add, never change or remove. Indexes build without locking; half-built leftovers dropped first, loud failure if any remain.
3. **Dual-write behind a flag.** One transaction writes the attempt, stop status, and `pods` summary. Soak, watching v1 latency.
4. **Backfill.** Copy 14M old rows in batches of 1,000 with pauses; resumable and idempotent (IDs derive from the old rows); verified by counts, checksums, a sample compare.
5. **New reads for new surfaces only.** `GET /api/stops` stays on `pods`: moving a frozen read path gains nothing and risks the contract.
6. **Sunset gate.** Removal starts only after v1 traffic is zero for seven days.
7. **Remove, in order.** Flag off -> block writes at the database (a tripwire) -> return 410 -> rename the table (instantly reversible) -> drop one release later. Step 1 is a live flag; steps 2 to 5 are designed, not built.

**The summary is ordered by the server clock**: a wrong future phone date cannot freeze what v1 sees.

## Rollout and forced update

**Two levers.** `minAppVersion` gives grace on a saved timer and blocks at a 12-hour ceiling; a kill switch blocks at once when a build endangers evidence. Policy rides on API responses as headers; a change lands at the next sync.

**Both block new captures only.** Uploading already-captured evidence is always allowed; losing proof costs more than any bug an update fixes.

**Depot rings.** Internal -> one depot -> 25% -> everyone, gated on crash-free rate.

## Performance

API measured from a same-region server: **p95 13.1ms** on one `t3.small` with Postgres alongside. Flat to ~95 rps, the knee at ~142 (p95 43ms), full near 200 with zero HTTP errors though a third of offered work is turned away rather than errored. Fleet steady state ~115 rps fits; bursts need three to four instances. One box carries it because **photos never pass through the API**: the attempt POST returns signed upload links, bytes go straight to S3, and the server checks each file exists.

Depot map: the old design sent all ~5,000 stops (~850KB) and grouped them on the phone; the shipped design sends only the visible viewport, grouped in Postgres, with the map engine drawing the pins itself and no UI component per stop. Measured on a Samsung S24 FE, release build, scripted camera tour: **p95 frame time 7ms, jank 1.1-2.5%, 465-479MB PSS** across two runs. The old design was not re-measured, so no before/after multiple is claimed.

## Security, retention and erasure

**Photos have one door.** Private bucket; the database stores keys, not links; the only way in is an authenticated endpoint that checks the caller and issues a 300-second link.

**The AI provider gets the note text and outcome word only**, never an address, name, GPS, or photo; a test asserts it against the outbound request.

**Retention is six years (confirmed).** Evidence is excluded from GDPR erasure under the legal-claims exemption (Art. 17(3)(e)), structurally: the app's database role cannot delete it. The erasure routine wipes contact fields, cancels tokens, invalidates the credential so sign-in fails, and logs field names only, never values.

**Found and fixed in self-audit:** an S3 lifecycle rule quietly deleting evidence at 550 days against the 6-year duty (S3 deletes it itself, so no app log would show it); two owner-level demo scripts able to destroy real attempts, now locked to demo data; a test approving a safe-place location leak as valid AI output, inverted; and two later migrations that had quietly dropped the build-without-locking rule.

## What breaks at 100x

**Photos first**, projected rather than measured: signed links minted one at a time, and storage write limits per key path. Fix: batch the links, spread the keys, verify in background workers. **v1's full-history endpoint second:** unbounded by design for byte-compatibility, so statement timeouts are the first fix and retiring v1 is the real one. **Conflict review third:** the flag scales, the human process needs triage tools. **The pods summary:** a background job, or let it die with v1. **Not Postgres:** append-only inserts scale; split the table by month; move the database to its own box first.

## Deliberately not built, and assumptions

Office UI (client: read APIs, hit by curl). Conflict resolution workflow (sanctioned). Background sync: battery managers kill it, and the saved queue makes timing irrelevant. Day-list paging: a day is 120-180 stops, ~50KB, one fetch; paging adds offline failure modes to a non-problem. Edit or delete APIs on attempts: the absence is the feature. iOS, CI pipeline, push, route optimisation, admin CRUD. Offline map tiles: the offline promise is the work list; the map degrades honestly. Cross-day parcel history: a round is one day; redelivery is tomorrow's stop. Fleet-wide rate-limit counters (per identity, but counted per instance in memory). Pool phones beyond queue scoping: logout semantics would still need work.

## AI tooling

**Used throughout, most usefully as an adversary.** Review passes found real defects: a retry path that silenced a device for a day, and a committed Terraform plan leaking account details. Each verified against the code; several rejected.

**Overrides.** IP-based rate limiting rejected: carriers put thousands of phones behind one IP, so sign-in is limited per account instead. A suggested "fix" that loosened a failing token test, rejected: the honest fix pinned the real rule: one live token, never a self-inflicted logout.
