-- ---------------------------------------------------------------------------
-- aurora-verify.sql
--
-- The evidence half of infra/aurora-migrate.sh. This exact file is run against
-- BOTH databases, by the same psql binary, and the two outputs are compared
-- line for line. That is the whole reason it is one file and not two sets of
-- queries: verification written twice can agree with itself while both halves
-- are wrong in the same way.
--
-- It is strictly read only. Nothing here writes, and nothing takes a lock
-- heavier than a plain SELECT, so running it against the live source database
-- while the API is serving traffic costs that database nothing but a few
-- sequential scans. aurora-migrate.sh additionally opens every source session
-- with default_transaction_read_only=on, so the source server itself refuses
-- any write this file could somehow attempt.
--
-- Nothing here needs a superuser. Aurora's master user is rds_superuser and
-- not a true superuser, so every catalog read below is one an ordinary table
-- owner can perform.
--
-- Output is one record per line, pipe separated, first field a section tag:
--
--   SERVER|<version>
--   TABLE|<name>
--   COLUMN|<table>|<position>|<name>|<type>|<notnull>
--   CONSTRAINT|<table>|<name>|<contype>|<definition>
--   INDEX|<index>|<table>|<valid>|<ready>|<unique>
--   SEQUENCE|<name>
--   MIGRATION|<timestamp>|<name>
--   COUNT|<table>|<rows>
--   CKSUM|<table>|<md5>
--   GRANT|<table>|<sel>|<ins>|<upd>|<del>|<trunc>|<anycol_upd>|<updatable_columns>
--
-- The tag prefix is what lets the driver script compare sections
-- independently, so a legitimate difference in one (applied migrations, say)
-- does not drown out a real one in another (row checksums).
-- ---------------------------------------------------------------------------

-- QUIET first and before anything else, or psql acknowledges each \pset and
-- prints a command tag for each SET below, and those lines land in the output
-- the driver script parses.
\set QUIET on
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset fieldsep '|'
\pset null ''
\pset footer off
\timing off

-- These six settings are load bearing, not tidiness.
--
-- The row checksums below render every row as text, and half of what "as text"
-- means is session state: timestamptz prints in the session time zone,
-- double precision prints to extra_float_digits places, dates print in
-- DateStyle order. Two servers left on their own defaults can hold byte
-- identical data and produce different text for it, which would fail the
-- comparison for a reason that has nothing to do with the migration. Pinning
-- them here, in the file both sides run, removes that whole class of false
-- alarm and the matching class of false reassurance.
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, MDY';
SET IntervalStyle = 'postgres';
SET extra_float_digits = 3;
SET bytea_output = 'hex';
SET search_path = public, pg_catalog;
SET statement_timeout = '15min';

-- ---------------------------------------------------------------------------
-- SERVER. Aurora is pinned to 16.14 to match the container exactly, and the
-- row rendering above is only guaranteed comparable between equal majors.
-- ---------------------------------------------------------------------------
SELECT 'SERVER', current_setting('server_version');

-- ---------------------------------------------------------------------------
-- TABLE. The inventory exists so the driver can assert that the fixed list of
-- tables it copies is still the complete list. A migration that adds a table
-- would otherwise be copied by nobody and noticed by no one.
-- ---------------------------------------------------------------------------
SELECT 'TABLE', c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p')
 ORDER BY c.relname;

-- ---------------------------------------------------------------------------
-- COLUMN. This runs before the checksums for a reason: a row rendered as text
-- is positional, so the checksum comparison is only meaningful once both sides
-- are known to present the same columns, in the same order, with the same
-- types. If this section differs, a checksum difference tells you nothing you
-- did not already know.
--
-- Position is the row_number over live columns rather than attnum, because a
-- column dropped on one side and never present on the other leaves an attnum
-- gap that the text rendering does not have. Comparing attnum would report a
-- difference the data does not contain.
-- ---------------------------------------------------------------------------
SELECT 'COLUMN', t.relname, t.pos::text, t.attname, t.typ, t.notnull
  FROM (
        SELECT c.relname,
               row_number() OVER (PARTITION BY c.relname ORDER BY a.attnum) AS pos,
               a.attname,
               format_type(a.atttypid, a.atttypmod) AS typ,
               a.attnotnull::text AS notnull
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND a.attnum > 0
           AND NOT a.attisdropped
       ) t
 ORDER BY t.relname, t.pos;

-- ---------------------------------------------------------------------------
-- CONSTRAINT. The CHECK constraints on delivery_attempts are the database half
-- of the evidence rules: a neighbour delivery must name a house number, a
-- refusal must carry a reason, an outcome must be one of six. Those are the
-- reason the table can be trusted, and a migration that silently arrived
-- without them would leave the schema looking right and the guarantees gone.
-- Foreign keys appear here too, which is what makes the load order in the
-- driver script checkable rather than assumed.
-- ---------------------------------------------------------------------------
SELECT 'CONSTRAINT', rel.relname, con.conname, con.contype::text,
       pg_get_constraintdef(con.oid)
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY rel.relname, con.conname;

-- ---------------------------------------------------------------------------
-- INDEX. indisvalid is the one that matters. Every hot path index in this
-- schema is built CONCURRENTLY, and a CONCURRENTLY build that fails part way
-- leaves the index in place, INVALID, and invisible to the planner. Nothing
-- errors, nothing is missing from \d, and the query it was built for silently
-- goes back to a sequential scan. On a fresh Aurora with 12k rows a seq scan
-- is fast enough that no smoke test would ever catch it.
-- ---------------------------------------------------------------------------
SELECT 'INDEX', ic.relname, tc.relname,
       i.indisvalid::text, i.indisready::text, i.indisunique::text
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = ic.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY ic.relname;

-- ---------------------------------------------------------------------------
-- SEQUENCE. Every business primary key in this schema is a uuid with a
-- gen_random_uuid() default, so there is no sequence to resynchronise after a
-- data only copy. The single exception is migrations_id_seq, and the migrations
-- table is deliberately not copied.
--
-- That is true today and would stop being true the moment somebody adds a
-- serial or identity column, at which point a data only copy would leave the
-- new sequence sitting at 1 and the first insert after cutover would collide
-- with a copied row. Listing them is how that change announces itself instead
-- of waiting to be discovered in production.
-- ---------------------------------------------------------------------------
SELECT 'SEQUENCE', c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'S'
 ORDER BY c.relname;

-- ---------------------------------------------------------------------------
-- MIGRATION. Names, not just a count. A count that matches proves the right
-- NUMBER of migrations ran, which is a different claim from the right ones
-- having run, and the driver diffs the names for exactly that reason.
-- ---------------------------------------------------------------------------
SELECT 'MIGRATION', m."timestamp"::text, m.name
  FROM migrations m
 ORDER BY m."timestamp", m.name;

-- ---------------------------------------------------------------------------
-- COUNT. Every table, including migrations, which the driver checks separately
-- because it is the one table that is legitimately allowed to differ: it is
-- rebuilt by running the migrations rather than copied.
-- ---------------------------------------------------------------------------
SELECT 'COUNT', t, n::text
  FROM (
                    SELECT 'ai_summaries'      AS t, count(*) AS n FROM ai_summaries
          UNION ALL SELECT 'ai_summary_cache',      count(*)       FROM ai_summary_cache
          UNION ALL SELECT 'attempt_photos',        count(*)       FROM attempt_photos
          UNION ALL SELECT 'backfill_progress',     count(*)       FROM backfill_progress
          UNION ALL SELECT 'delivery_attempts',     count(*)       FROM delivery_attempts
          UNION ALL SELECT 'devices',               count(*)       FROM devices
          UNION ALL SELECT 'drivers',               count(*)       FROM drivers
          UNION ALL SELECT 'erasure_log',           count(*)       FROM erasure_log
          UNION ALL SELECT 'migrations',            count(*)       FROM migrations
          UNION ALL SELECT 'office_users',          count(*)       FROM office_users
          UNION ALL SELECT 'pods',                  count(*)       FROM pods
          UNION ALL SELECT 'refresh_tokens',        count(*)       FROM refresh_tokens
          UNION ALL SELECT 'stops',                 count(*)       FROM stops
       ) s
 ORDER BY t;

-- ---------------------------------------------------------------------------
-- CKSUM. A count proves the right number of rows arrived. It does not prove
-- they are the same rows, and it is exactly the check that passes when a
-- column was truncated, a timestamp lost its zone, or a jsonb payload arrived
-- empty. This is the check that fails in those cases.
--
-- md5 of each row rendered as text, sorted by that hash, concatenated, hashed
-- again.
--
--   order independent, because COPY makes no promise about the physical order
--   rows are reinserted in, and a straight md5 of the table would differ for
--   two identical tables. Sorting by the row hash rather than by a primary key
--   also means the expression needs no knowledge of any particular table, and
--   duplicate rows still land in a stable position.
--
--   content sensitive to the column, because the row text carries every value.
--   A single flipped boolean anywhere in 8,320 stops changes the final digest.
--
-- migrations is excluded on purpose. Its id is the one serial in the schema
-- and its rows are written by the migration runner on each side independently,
-- so the two sides legitimately differ and a checksum over it would fail every
-- run for a reason that is not a fault. Its names are compared instead, above.
-- ---------------------------------------------------------------------------
SELECT 'CKSUM', t, v
  FROM (
          SELECT 'ai_summaries' AS t, coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY') AS v
            FROM (SELECT md5(x::text) AS h FROM ai_summaries x) q
UNION ALL SELECT 'ai_summary_cache', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM ai_summary_cache x) q
UNION ALL SELECT 'attempt_photos', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM attempt_photos x) q
UNION ALL SELECT 'backfill_progress', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM backfill_progress x) q
UNION ALL SELECT 'delivery_attempts', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM delivery_attempts x) q
UNION ALL SELECT 'devices', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM devices x) q
UNION ALL SELECT 'drivers', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM drivers x) q
UNION ALL SELECT 'erasure_log', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM erasure_log x) q
UNION ALL SELECT 'office_users', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM office_users x) q
UNION ALL SELECT 'pods', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM pods x) q
UNION ALL SELECT 'refresh_tokens', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM refresh_tokens x) q
UNION ALL SELECT 'stops', coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')
            FROM (SELECT md5(x::text) AS h FROM stops x) q
       ) s
 ORDER BY t;

-- ---------------------------------------------------------------------------
-- GRANT. The append only posture, read straight out of the catalog on both
-- sides so it can be compared rather than asserted from memory.
--
-- has_table_privilege and friends are used rather than
-- information_schema.table_privileges because they answer the question that
-- actually matters. information_schema reports grants made TO a named role.
-- These functions report what the role can DO, counting privileges reaching it
-- through PUBLIC and through role membership as well as directly. A DELETE
-- granted to PUBLIC would be invisible to the first and caught by the second.
--
-- The distinction between the update columns matters as much as the deletes:
--
--   upd        table level UPDATE. Must be false on delivery_attempts and
--              attempt_photos. Column level grants are deliberately NOT
--              counted here, which is why the next column exists.
--   anycol_upd true if any single column is updatable. True on both evidence
--              tables, and it is the pair of these two columns that says
--              "some columns, not the table".
--   the list   exactly which columns. Five on delivery_attempts, four on
--              attempt_photos, and the driver checks them by name. A grant
--              that crept onto outcome or captured_at would pass a count and
--              fail here.
--
-- This section is last because it references the pod_app role by name and
-- errors if that role does not exist. Put earlier, a missing role would abort
-- the file and take the row counts and checksums down with it, hiding the
-- answer to the question that was actually being asked.
-- ---------------------------------------------------------------------------
SELECT 'GRANT', c.relname,
       has_table_privilege('pod_app', c.oid, 'SELECT')::int::text,
       has_table_privilege('pod_app', c.oid, 'INSERT')::int::text,
       has_table_privilege('pod_app', c.oid, 'UPDATE')::int::text,
       has_table_privilege('pod_app', c.oid, 'DELETE')::int::text,
       has_table_privilege('pod_app', c.oid, 'TRUNCATE')::int::text,
       has_any_column_privilege('pod_app', c.oid, 'UPDATE')::int::text,
       coalesce((SELECT string_agg(a.attname, ',' ORDER BY a.attname)
                   FROM pg_attribute a
                  WHERE a.attrelid = c.oid
                    AND a.attnum > 0
                    AND NOT a.attisdropped
                    AND has_column_privilege('pod_app', c.oid, a.attnum, 'UPDATE')), '')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p')
 ORDER BY c.relname;
