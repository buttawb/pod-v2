import { createHash } from 'node:crypto';
import { uuidv5 } from '../src/common/uuid5';
import { AppDataSource } from '../src/database/data-source';

/**
 * Phase 3 backfill: pods (14M in production, ~3k in the seed) into
 * delivery_attempts, plus parsing legacy "lat,lng" strings into typed
 * stop coordinates.
 *
 * Properties that make this safe against a live database:
 * - Keyset pagination over (created_at, id): no OFFSET scans, constant cost.
 * - Batched with a sleep between batches; batch size and sleep are the
 *   throttle knobs (production run would also watch replication lag / p95).
 * - Idempotent AND resumable by construction: client_attempt_id =
 *   uuidv5(pod.id) is deterministic and inserts are ON CONFLICT DO NOTHING;
 *   progress checkpoints to backfill_progress so a killed run resumes.
 * - Purely additive: no v1 reader touches delivery_attempts, so "rollback"
 *   is simply deleting rows tagged source='backfill' (or re-running).
 * - Skips the pods projection: pods is already the truth for these rows.
 *
 * Verification at the end: per-day row counts and a content checksum
 * comparing source and destination, plus a random sample field diff.
 */

const JOB_ID = 'pods_backfill';
const BACKFILL_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c9';
const BATCH_SIZE = Number(process.env.BACKFILL_BATCH ?? 1000);
const SLEEP_MS = Number(process.env.BACKFILL_SLEEP_MS ?? 200);
const LEGACY_APP_VERSION = '<=1.4.2';

interface PodRow {
  id: string;
  stop_id: string;
  delivered: boolean;
  photo_url: string | null;
  signature_url: string | null;
  location: string | null;
  note: string | null;
  created_at: Date;
  driver_id: string;
  stop_location: string;
}

function parseLatLng(value: string | null): { lat: number; lng: number } | null {
  if (!value) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function backfillAttempts(): Promise<number> {
  const [checkpoint] = (await AppDataSource.query(
    `SELECT last_created_at, last_id, rows_done FROM backfill_progress WHERE job_id = $1`,
    [JOB_ID],
  )) as Array<{ last_created_at: Date | null; last_id: string | null; rows_done: string }>;

  let lastCreatedAt = checkpoint?.last_created_at
    ? new Date(checkpoint.last_created_at).toISOString()
    : new Date(0).toISOString();
  let lastId = checkpoint?.last_id ?? '00000000-0000-0000-0000-000000000000';
  let total = Number(checkpoint?.rows_done ?? 0);
  if (total > 0) console.log(`Resuming from checkpoint: ${total} rows already done`);

  for (;;) {
    const batch = (await AppDataSource.query(
      `SELECT p.id, p.stop_id, p.delivered, p.photo_url, p.signature_url, p.location,
              p.note, p.created_at, s.driver_id, s.location AS stop_location
       FROM pods p
       JOIN stops s ON s.id = p.stop_id
       WHERE (p.created_at, p.id) > ($1::timestamptz, $2::uuid)
       ORDER BY p.created_at ASC, p.id ASC
       LIMIT $3`,
      [lastCreatedAt, lastId, BATCH_SIZE],
    )) as PodRow[];
    if (batch.length === 0) break;

    const values: string[] = [];
    const params: unknown[] = [];
    let skippedNoCoords = 0;

    batch.forEach((pod) => {
      const coords = parseLatLng(pod.location) ?? parseLatLng(pod.stop_location);
      if (!coords) {
        skippedNoCoords += 1;
        return;
      }
      const rawPayload = JSON.stringify({
        pod_id: pod.id,
        delivered: pod.delivered,
        photo_url: pod.photo_url,
        signature_url: pod.signature_url,
        location: pod.location,
        note: pod.note,
      });
      const base = params.length;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},'backfill',0,'complete',$${base + 12})`,
      );
      params.push(
        uuidv5(pod.id, BACKFILL_NS),
        pod.stop_id,
        pod.driver_id,
        pod.delivered ? 'delivered_to_person' : 'no_answer_carded',
        pod.note,
        coords.lat,
        coords.lng,
        pod.created_at,
        LEGACY_APP_VERSION,
        rawPayload,
        pod.created_at,
        createHash('sha256').update(rawPayload).digest('hex'),
      );
    });

    if (values.length > 0) {
      await AppDataSource.query(
        `INSERT INTO delivery_attempts (
           client_attempt_id, stop_id, driver_id, outcome, note, lat, lng,
           captured_at, app_version, raw_payload, received_at,
           source, declared_photo_count, evidence_status, payload_hash
         ) VALUES ${values.join(',')}
         ON CONFLICT (client_attempt_id) DO NOTHING`,
        params,
      );
    }
    if (skippedNoCoords > 0) {
      console.warn(`  batch: ${skippedNoCoords} pods skipped (no parseable coordinates) - logged, not silently dropped`);
    }

    const last = batch[batch.length - 1];
    lastCreatedAt = new Date(last.created_at).toISOString();
    lastId = last.id;
    total += batch.length;

    await AppDataSource.query(
      `INSERT INTO backfill_progress (job_id, last_created_at, last_id, rows_done, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (job_id) DO UPDATE SET
         last_created_at = EXCLUDED.last_created_at, last_id = EXCLUDED.last_id,
         rows_done = EXCLUDED.rows_done, updated_at = now()`,
      [JOB_ID, lastCreatedAt, lastId, total],
    );

    console.log(`  ${total} pods processed (checkpointed)`);
    await sleep(SLEEP_MS);
  }
  return total;
}

/** Expand-phase data fix riding along: parse legacy location strings into typed columns. */
async function backfillStopCoords(): Promise<void> {
  // TypeORM returns [rows, rowCount] for UPDATE queries.
  const result = (await AppDataSource.query(
    `WITH parsed AS (
       SELECT id,
              split_part(location, ',', 1)::double precision AS lat,
              split_part(location, ',', 2)::double precision AS lng
       FROM stops
       WHERE lat IS NULL
         AND location ~ '^\\s*-?\\d+(\\.\\d+)?\\s*,\\s*-?\\d+(\\.\\d+)?\\s*$'
     )
     UPDATE stops s SET lat = p.lat, lng = p.lng, updated_at = now()
     FROM parsed p WHERE s.id = p.id`,
  )) as [unknown[], number];
  console.log(`Stop coordinates parsed: ${result[1]}`);

  const [{ n }] = (await AppDataSource.query(
    `SELECT count(*)::int AS n FROM stops WHERE lat IS NULL`,
  )) as Array<{ n: number }>;
  if (n > 0) console.warn(`  ${n} stops still have unparseable locations - flagged, not silently dropped`);
}

async function verify(): Promise<boolean> {
  console.log('\nVerification:');

  const counts = (await AppDataSource.query(
    `SELECT
       (SELECT count(*) FROM pods)::int AS pods,
       (SELECT count(*) FROM delivery_attempts WHERE source = 'backfill')::int AS backfilled`,
  )) as Array<{ pods: number; backfilled: number }>;
  console.log(`  total: pods=${counts[0].pods} backfilled=${counts[0].backfilled}`);

  const dayMismatch = (await AppDataSource.query(
    `SELECT coalesce(p.day, a.day) AS day, coalesce(p.n, 0) AS pods, coalesce(a.n, 0) AS attempts
     FROM (SELECT created_at::date AS day, count(*)::int AS n FROM pods GROUP BY 1) p
     FULL OUTER JOIN (
       SELECT captured_at::date AS day, count(*)::int AS n
       FROM delivery_attempts WHERE source = 'backfill' GROUP BY 1
     ) a ON a.day = p.day
     WHERE coalesce(p.n, 0) <> coalesce(a.n, 0)
     ORDER BY 1`,
  )) as Array<{ day: string; pods: number; attempts: number }>;
  if (dayMismatch.length === 0) console.log('  per-day counts: MATCH');
  else console.log(`  per-day counts: ${dayMismatch.length} MISMATCHED buckets`, dayMismatch.slice(0, 5));

  const checksum = (await AppDataSource.query(
    `SELECT
       (SELECT sum(hashtextextended(stop_id::text || delivered::text || coalesce(note, ''), 0))
        FROM pods) AS src,
       (SELECT sum(hashtextextended(
          stop_id::text || (outcome = 'delivered_to_person')::text || coalesce(note, ''), 0))
        FROM delivery_attempts WHERE source = 'backfill') AS dst`,
  )) as Array<{ src: string; dst: string }>;
  const checksumOk = checksum[0].src === checksum[0].dst;
  console.log(`  content checksum: ${checksumOk ? 'MATCH' : `MISMATCH (src=${checksum[0].src} dst=${checksum[0].dst})`}`);

  const sample = (await AppDataSource.query(
    `SELECT p.id FROM pods p TABLESAMPLE BERNOULLI (5) LIMIT 100`,
  )) as Array<{ id: string }>;
  let sampleFailures = 0;
  for (const { id } of sample) {
    const [row] = (await AppDataSource.query(
      `SELECT (p.delivered = (a.outcome = 'delivered_to_person')
               AND coalesce(p.note, '') = coalesce(a.note, '')
               AND p.created_at = a.captured_at) AS ok
       FROM pods p
       JOIN delivery_attempts a ON a.client_attempt_id = $2::uuid
       WHERE p.id = $1`,
      [id, uuidv5(id, BACKFILL_NS)],
    )) as Array<{ ok: boolean }>;
    if (!row?.ok) sampleFailures += 1;
  }
  console.log(`  random sample (${sample.length} rows): ${sampleFailures === 0 ? 'MATCH' : `${sampleFailures} FAILURES`}`);

  return dayMismatch.length === 0 && checksumOk && sampleFailures === 0;
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const started = Date.now();

  console.log(`Backfilling pods -> delivery_attempts (batch=${BATCH_SIZE}, sleep=${SLEEP_MS}ms)...`);
  const total = await backfillAttempts();
  await backfillStopCoords();
  const ok = await verify();

  console.log(`\n${ok ? 'BACKFILL VERIFIED' : 'BACKFILL HAS DISCREPANCIES - investigate before cutover'}`);
  console.log(`${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await AppDataSource.destroy();
  process.exit(ok ? 0 : 1);
}

void main();
