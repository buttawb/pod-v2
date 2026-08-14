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
-- Idempotent: once the newest demo stop is already in today the shift is zero
-- and the UPDATE matches no rows.
--
-- SCOPED TO THE DEMO DRIVERS, and that scope is load bearing twice over.
--
-- The table also holds a large synthetic history belonging to EMP-BULK- drivers,
-- deliberately spread across two years so the read paths can be measured against
-- something the size of the real system. Rolling that would rewrite tens of
-- millions of rows every night to no purpose, and it would flatten the date
-- range that makes those measurements worth anything.
--
-- It matters for the shift too, not just the row count. Taken across the whole
-- table, max(created_at) is the newest synthetic row rather than the newest demo
-- stop, so the interval would be computed from data that has nothing to do with
-- the round being rolled, and the demo would stay expired while the query
-- reported success.

BEGIN;

WITH demo AS (
  SELECT s.id, s.created_at
    FROM stops s
    JOIN drivers d ON d.id = s.driver_id
   WHERE d.employee_ref NOT LIKE 'EMP-BULK-%'
),
shift AS (
  SELECT EXTRACT(
           DAY FROM date_trunc('day', now()) - date_trunc('day', max(created_at))
         )::int AS days
    FROM demo
)
UPDATE stops
   SET created_at = stops.created_at + make_interval(days => (SELECT days FROM shift)),
       updated_at = now()
  FROM demo
 WHERE demo.id = stops.id
   AND stops.created_at < date_trunc('day', now());

COMMIT;

SELECT count(*) AS stops_today,
       count(*) FILTER (WHERE s.status = 'pending') AS pending
  FROM stops s
  JOIN drivers d ON d.id = s.driver_id
 WHERE d.employee_ref NOT LIKE 'EMP-BULK-%'
   AND s.created_at >= date_trunc('day', now());
