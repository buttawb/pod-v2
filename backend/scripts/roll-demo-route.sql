-- Moves the seeded round into the current day.
--
-- The production image ships compiled output only, so the TypeScript version
-- of this (scripts/roll-demo-route.ts) cannot run there. This is the same
-- operation, runnable with psql alone.
--
-- A driver's route is "today's work": stops are selected with
-- created_at >= date_trunc('day', now()). That is correct for the product,
-- dispatch assigns a fresh round each morning, but it means seeded demo data
-- expires at midnight UTC and the app shows an empty round the next day.
--
-- Every stop older than today shifts forward by the same whole number of days,
-- so the round keeps its shape: sequence, spread across the morning, and which
-- stops were already delivered. Nothing is deleted. delivery_attempts are
-- append-only evidence and are not touched.
--
-- Idempotent: once the newest stop is already in today the shift is zero and
-- the UPDATE matches no rows.

BEGIN;

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

COMMIT;

SELECT count(*) AS stops_today,
       count(*) FILTER (WHERE status = 'pending') AS pending
  FROM stops
 WHERE created_at >= date_trunc('day', now());
