-- Moves the seeded demo day into the current one, as a single coherent unit.
--
-- THIS IS A FIXTURE SCRIPT. It rewrites timestamps, including on
-- delivery_attempts, which the product treats as append-only evidence. That is
-- acceptable here only because these rows are generated demo data and the
-- alternative is worse: an earlier version of this script moved the stops and
-- left their attempts behind, which is how the dashboard came to report 18
-- delivered stops and 0 attempts today. A demo that contradicts itself on the
-- front page of an evidence product is a worse lie than a shifted fixture.
-- It must never be run against real data.
--
-- Two things happen here.
--
-- 1. Stops older than today shift forward by whole days, so the round keeps its
--    shape: sequence, spread, and which stops were already worked.
--
-- 2. Attempts are re-timed across the morning up to now, preserving their
--    original order. The seed inserted them in a couple of bulk batches, so
--    every row shared a timestamp and the "live" page looked like one insert
--    rather than a day in progress. Nothing is placed in the future.
--
-- Idempotent: re-running re-spreads the same rows across the window to now.

BEGIN;

-- 1. The round.
UPDATE stops
   SET created_at = created_at + make_interval(
         days => (
           SELECT EXTRACT(
                    DAY FROM date_trunc('day', now()) - date_trunc('day', max(created_at))
                  )::int
             FROM stops
         )
       ),
       updated_at = now()
 WHERE created_at < date_trunc('day', now());

-- 2. The work done on it, spread across the last four hours in original order.
WITH ordered AS (
  SELECT id,
         row_number() OVER (ORDER BY captured_at, id) AS n,
         count(*) OVER ()                             AS total
    FROM delivery_attempts
),
retimed AS (
  SELECT id,
         n,
         now()
           - interval '4 hours'
           + ((n - 1) * (interval '4 hours' / greatest(total, 1))) AS captured
    FROM ordered
)
UPDATE delivery_attempts a
   SET captured_at = r.captured,
       -- A realistic sync lag. Every tenth attempt reaches us much later, which
       -- is what a morning in a signal blackspot actually looks like, and it
       -- gives the two-clock model something real to show.
       received_at = r.captured
                     + interval '45 seconds'
                     + CASE WHEN (r.n % 10) = 0 THEN interval '35 minutes'
                            ELSE interval '0 seconds' END,
       updated_at = now()
  FROM retimed r
 WHERE a.id = r.id;

COMMIT;

-- Reconciliation: these must agree with the dashboard's cards.
SELECT (SELECT count(*) FROM stops WHERE created_at >= date_trunc('day', now()))            AS stops_today,
       (SELECT count(*) FROM stops
         WHERE created_at >= date_trunc('day', now()) AND status <> 'pending')               AS stops_worked,
       (SELECT count(*) FROM delivery_attempts WHERE received_at >= date_trunc('day', now())) AS attempts_today,
       (SELECT count(*) FROM delivery_attempts
         WHERE received_at >= date_trunc('day', now())
           AND evidence_status = 'pending_media')                                            AS awaiting_evidence,
       (SELECT count(DISTINCT date_trunc('hour', captured_at)) FROM delivery_attempts)        AS capture_hours;
