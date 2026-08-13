import { hashSync } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../data-source';

/**
 * Seeds the reviewer-facing dataset:
 * - 1 well-known test driver (150 stops today) + 32 other drivers
 * - ~5,000 stops across Greater London dated TODAY (the depot map set)
 * - ~3,000 HISTORICAL stops with legacy `pods` rows only, so the
 *   backfill script (scripts/backfill-pods.ts) can be run and verified
 * - 1 office user for the dashboard
 *
 * Deterministic: fixed RNG seed, so every perf run sees identical data.
 */

const TEST_DRIVER_REF = 'EMP-TEST-001';
const TEST_DRIVER_PASSWORD = 'TestDriver#2026';
const OFFICE_EMAIL = 'office@demo.pod';
const OFFICE_PASSWORD = 'OfficeDemo#2026';

const DRIVER_COUNT = 33;
const TODAY_STOPS = 5000;
const STOPS_PER_DRIVER = Math.floor(TODAY_STOPS / DRIVER_COUNT);
const HISTORICAL_STOPS = 3000;

/** A Pakistan depot: its own drivers, its own round, its own city. */
const PK_DRIVER_COUNT = 8;
const PK_STOPS = 320;
const PK_TEST_DRIVER_REF = 'EMP-PK-001';

// Real London outward codes with rough centroids; inward codes generated.
// Gaussian jitter inside each district gives clustering realistic density
// variation (dense zone 1-2, sparse outskirts).
const DISTRICTS: Array<[string, number, number]> = [
  ['E1', 51.5175, -0.0596], ['E2', 51.5296, -0.0567], ['E14', 51.5076, -0.0172],
  ['E17', 51.5886, -0.0208], ['N1', 51.5362, -0.1033], ['N4', 51.5715, -0.1053],
  ['N16', 51.5606, -0.0743], ['NW1', 51.5346, -0.1441], ['NW3', 51.5502, -0.1744],
  ['NW10', 51.5372, -0.2477], ['SE1', 51.4985, -0.0895], ['SE8', 51.4790, -0.0250],
  ['SE15', 51.4713, -0.0644], ['SE22', 51.4525, -0.0736], ['SW2', 51.4508, -0.1225],
  ['SW9', 51.4650, -0.1122], ['SW11', 51.4642, -0.1670], ['SW19', 51.4216, -0.2080],
  ['W2', 51.5145, -0.1793], ['W6', 51.4927, -0.2240], ['W12', 51.5063, -0.2372],
  ['WC1', 51.5225, -0.1235], ['EC1', 51.5246, -0.0996], ['CR0', 51.3762, -0.0982],
  ['BR1', 51.4066, 0.0154], ['DA1', 51.4425, 0.2140], ['RM6', 51.5732, 0.1279],
  ['IG1', 51.5588, 0.0709], ['EN1', 51.6538, -0.0645], ['HA1', 51.5788, -0.3372],
  ['UB1', 51.5107, -0.3752], ['TW3', 51.4686, -0.3613], ['KT1', 51.4103, -0.3025],
  ['SM1', 51.3618, -0.1945], ['N9', 51.6266, -0.0663], ['E6', 51.5255, 0.0517],
  ['SE28', 51.5013, 0.1207], ['SW16', 51.4218, -0.1235], ['W3', 51.5114, -0.2678],
  ['NW9', 51.5883, -0.2521],
];

/**
 * Pakistan, as its own round rather than mixed into a London driver's day.
 *
 * A driver's stops have to be drivable in one shift, so scattering Karachi
 * addresses through a London round would produce a route map spanning two
 * continents and a "next stop" that is a six hour flight away. These belong to
 * their own drivers out of their own depot, which is also what makes the depot
 * map meaningful: two real clusters, not one cluster and a smear.
 *
 * Postcodes are Pakistan Post's five digit codes and the coordinates are the
 * real centres of those areas, so the map is not decorative.
 */
const PK_DISTRICTS: Array<[string, number, number]> = [
  // Karachi
  ['75500', 24.8607, 67.0011], ['75300', 24.8918, 67.0281], ['75600', 24.8615, 67.0099],
  ['74200', 24.8738, 67.0424], ['75350', 24.9200, 67.0971], ['75400', 24.8329, 67.0781],
  ['74700', 24.9056, 67.0822], ['75950', 24.9425, 67.1147], ['75290', 24.8074, 67.0330],
  // Lahore
  ['54000', 31.5497, 74.3436], ['54660', 31.5204, 74.3587], ['54600', 31.4697, 74.2728],
  ['54792', 31.4826, 74.3095], ['54810', 31.5925, 74.3095], ['54770', 31.5010, 74.3441],
  // Islamabad and Rawalpindi
  ['44000', 33.6844, 73.0479], ['44090', 33.7294, 73.0931], ['44050', 33.6518, 73.1560],
  ['46000', 33.5651, 73.0169], ['46300', 33.5969, 73.0515],
  // Faisalabad, Multan, Peshawar
  ['38000', 31.4504, 73.1350], ['60000', 30.1575, 71.5249], ['25000', 34.0151, 71.5249],
];

const PK_STREET_NAMES = [
  'Shahrah-e-Faisal', 'Tariq Road', 'Zamzama Boulevard', 'Khayaban-e-Shahbaz',
  'Ferozepur Road', 'Mall Road', 'Jail Road', 'Gulberg Main Boulevard',
  'Jinnah Avenue', 'Margalla Road', 'Peshawar Road', 'University Road',
  'Canal Bank Road', 'Bahadurabad Chowrangi', 'Korangi Industrial Road',
];

const STREET_NAMES = [
  'High Street', 'Church Road', 'Station Road', 'Park Avenue', 'Victoria Road',
  'Green Lane', 'Manor Road', 'Kings Road', 'Queens Crescent', 'Mill Lane',
  'The Grove', 'Windsor Close', 'York Way', 'Albert Road', 'Grange Road',
];

// mulberry32: tiny deterministic PRNG, seeded so runs are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260811);

function gaussian(): number {
  // Box-Muller from two uniforms.
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

interface SeedStop {
  id: string;
  driverId: string;
  address: string;
  postcode: string;
  location: string;
  sequence: number;
  createdAt: string;
  lat: number | null;
  lng: number | null;
  expectedBarcode: string | null;
}

/** A plausible courier barcode. Deterministic under the seeded RNG. */
function makeBarcode(): string {
  const digits = String(Math.floor(rand() * 1e10)).padStart(10, '0');
  return `JD${digits}`;
}

/**
 * A working day, not a single instant.
 *
 * Every one of today's 5,000 stops used to be written with one identical
 * created_at, taken once before the loop. A demo of a delivery day where the
 * entire round was created in the same millisecond reads as a bulk import,
 * which is exactly what it was, and it makes any time-based view (the live
 * feed, the two-clock model, anything ordered by arrival) look like a single
 * spike instead of a day's work. Stops are now spread across an 08:00 to
 * 18:00 window in sequence order, so a driver's round advances through the
 * day the way a real one does.
 */
function dayTimestamp(fraction: number): string {
  const start = new Date();
  start.setHours(8, 0, 0, 0);
  const WORKING_MS = 10 * 3600_000;
  return new Date(start.getTime() + Math.floor(fraction * WORKING_MS)).toISOString();
}

type Region = 'uk' | 'pk';

function makeStop(
  driverId: string,
  sequence: number,
  createdAt: string,
  withCoords: boolean,
  region: Region = 'uk',
): SeedStop {
  const pk = region === 'pk';
  const table = pk ? PK_DISTRICTS : DISTRICTS;
  const [outward, cLat, cLng] = table[Math.floor(rand() * table.length)];
  const lat = cLat + gaussian() * 0.008;
  const lng = cLng + gaussian() * 0.012;
  const inward = `${1 + Math.floor(rand() * 9)}${'ABDEFGHJLNPQRSTUWXYZ'[Math.floor(rand() * 20)]}${'ABDEFGHJLNPQRSTUWXYZ'[Math.floor(rand() * 20)]}`;
  return {
    id: randomUUID(),
    driverId,
    // Pakistan Post codes are five digits with no inward part, so the UK
    // inward suffix is not appended: a postcode a driver cannot recognise is
    // worse than no postcode.
    address: pk
      ? `House ${1 + Math.floor(rand() * 400)}, ${pick(PK_STREET_NAMES)}`
      : `${1 + Math.floor(rand() * 240)} ${pick(STREET_NAMES)}`,
    postcode: pk ? outward : `${outward} ${inward}`,
    location: `${lat.toFixed(4)},${lng.toFixed(4)}`,
    sequence,
    createdAt,
    // Historical (v1-era) stops carry ONLY the legacy location string;
    // parsing them into lat/lng is the backfill script's job.
    lat: withCoords ? lat : null,
    lng: withCoords ? lng : null,
    // What dispatch says should be at this door. Only today's round carries
    // one: the barcode check is a v2 capture-time feature and back-dating it
    // onto v1-era stops would imply the old app had ever compared anything.
    expectedBarcode: withCoords ? makeBarcode() : null,
  };
}

async function insertStops(stops: SeedStop[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < stops.length; i += CHUNK) {
    const chunk = stops.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((s, j) => {
      const base = j * 10;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`,
      );
      params.push(s.id, s.driverId, s.address, s.postcode, s.location, s.sequence, s.createdAt, s.lat, s.lng, s.expectedBarcode);
    });
    await AppDataSource.query(
      `INSERT INTO stops (id, driver_id, address, postcode, location, sequence, created_at, lat, lng, expected_barcode)
       VALUES ${values.join(',')} ON CONFLICT (id) DO NOTHING`,
      params,
    );
  }
}

/**
 * Works part of a round: v2 attempts, the stop status they project, and the
 * `pods` summary v1 still reads.
 *
 * A seeded day where every stop is pending demonstrates an empty morning rather
 * than a delivery system. The London round only ever looked worked because
 * development traffic happened to land on it, which nothing a fresh install or
 * a rolled demo day inherits.
 *
 * These rows are FIXTURES, inserted straight into the table rather than through
 * POST /api/v2/attempts. Two consequences worth stating, because a reviewer
 * will find them:
 *
 *   - they declare no photographs and no signature, so evidence_status is
 *     'complete' in the honest sense that the server is owed nothing. There are
 *     no S3 objects behind them and the media endpoints will find none.
 *   - the capture API enforces the evidence matrix (a safe-place delivery needs
 *     a photograph); writing to the table directly bypasses it. Real captures
 *     cannot.
 *
 * Seeding only the two outcomes that need no media would make every worked stop
 * a refusal or a failed access, which misrepresents a round considerably more
 * than a fixture without a photograph does.
 */
async function seedWorkedAttempts(
  driverIds: string[],
  label: string,
  workedFraction: number,
): Promise<void> {
  // Weighted to look like a real morning: mostly delivered, with a tail of the
  // outcomes that make a round worth looking at on a map.
  const OUTCOMES: Array<[string, number]> = [
    ['delivered_to_person', 0.46],
    ['left_safe_place', 0.24],
    ['left_with_neighbour', 0.12],
    ['no_answer_carded', 0.12],
    ['access_failure', 0.04],
    ['refused', 0.02],
  ];
  const pickOutcome = (): string => {
    let r = rand();
    for (const [outcome, weight] of OUTCOMES) {
      if ((r -= weight) <= 0) return outcome;
    }
    return 'delivered_to_person';
  };
  const STATUS: Record<string, string> = {
    delivered_to_person: 'delivered',
    left_with_neighbour: 'delivered',
    left_safe_place: 'delivered',
    no_answer_carded: 'attempted',
    access_failure: 'attempted',
    refused: 'failed',
  };

  let worked = 0;
  for (const driverId of driverIds) {
    const stops = (await AppDataSource.query(
      `SELECT id, lat, lng, expected_barcode, created_at
         FROM stops
        WHERE driver_id = $1 AND created_at >= date_trunc('day', now())
        ORDER BY sequence ASC`,
      [driverId],
    )) as Array<{
      id: string;
      lat: number | null;
      lng: number | null;
      expected_barcode: string | null;
      created_at: Date;
    }>;

    // The worked portion is the FRONT of the round, because a driver works in
    // sequence. Scattering completions through the day would put a delivered
    // stop after fifty pending ones, which no real round looks like.
    const upTo = Math.floor(stops.length * workedFraction);
    for (let i = 0; i < upTo; i += 1) {
      const stop = stops[i];
      const outcome = pickOutcome();
      const capturedAt = new Date(stop.created_at).toISOString();
      const needsReason = outcome === 'refused' || outcome === 'access_failure';

      await AppDataSource.query(
        `INSERT INTO delivery_attempts
           (client_attempt_id, stop_id, driver_id, outcome, reason_code, neighbour_house_number,
            note, parcel_barcode, barcode_source, barcode_match, lat, lng, gps_accuracy_m,
            captured_at, received_at, app_version, source, declared_photo_count,
            evidence_status, payload_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scanned',true,$9,$10,$11,$12,$12,'2.0.0','v2',0,'complete',$13)
         ON CONFLICT (client_attempt_id) DO NOTHING`,
        [
          randomUUID(),
          stop.id,
          driverId,
          outcome,
          needsReason ? (outcome === 'refused' ? 'customer_refused' : 'gate_locked') : null,
          outcome === 'left_with_neighbour' ? String(1 + Math.floor(rand() * 90)) : null,
          outcome === 'left_safe_place' ? 'left round the back, gate was open' : null,
          stop.expected_barcode,
          stop.lat,
          stop.lng,
          6 + Math.floor(rand() * 18),
          capturedAt,
          randomUUID(),
        ],
      );

      await AppDataSource.query(`UPDATE stops SET status = $2, updated_at = now() WHERE id = $1`, [
        stop.id,
        STATUS[outcome],
      ]);

      // The projection v1.4.2 reads, in the shape the dual-write produces.
      await AppDataSource.query(
        `INSERT INTO pods (stop_id, delivered, location, note, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (stop_id) DO NOTHING`,
        [
          stop.id,
          STATUS[outcome] === 'delivered',
          stop.lat !== null && stop.lng !== null ? `${stop.lat},${stop.lng}` : null,
          needsReason ? 'could not complete' : null,
          capturedAt,
        ],
      );
      worked += 1;
    }
  }
  console.log(`Worked ${worked} stops for ${label} (attempts, stop status, pods summary).`);
}

async function main(): Promise<void> {
  await AppDataSource.initialize();

  const [{ n }] = (await AppDataSource.query(
    `SELECT count(*)::int AS n FROM drivers`,
  )) as Array<{ n: number }>;
  if (n > 0) {
    console.log('Database already seeded; skipping (drop volumes to reseed).');
    await AppDataSource.destroy();
    return;
  }

  console.log('Seeding drivers and office user...');
  const passwordHash = hashSync(TEST_DRIVER_PASSWORD, 10);
  const driverIds: string[] = [];
  for (let i = 0; i < DRIVER_COUNT; i += 1) {
    const id = randomUUID();
    driverIds.push(id);
    const ref = i === 0 ? TEST_DRIVER_REF : `EMP-${String(1000 + i)}`;
    await AppDataSource.query(
      `INSERT INTO drivers (id, employee_ref, display_name, password_hash, email)
       VALUES ($1,$2,$3,$4, lower($2) || '@fleet.local')`,
      [id, ref, i === 0 ? 'Test Driver' : `Driver ${1000 + i}`, passwordHash],
    );
  }
  // The Pakistan depot's drivers. Same password as the UK test driver so there
  // is one credential to remember when demonstrating either round.
  const pkDriverIds: string[] = [];
  for (let i = 0; i < PK_DRIVER_COUNT; i += 1) {
    const id = randomUUID();
    pkDriverIds.push(id);
    const ref = i === 0 ? PK_TEST_DRIVER_REF : `EMP-PK-${String(100 + i)}`;
    await AppDataSource.query(
      `INSERT INTO drivers (id, employee_ref, display_name, password_hash, email)
       VALUES ($1,$2,$3,$4, lower($2) || '@fleet.local')`,
      [id, ref, i === 0 ? 'Karachi Test Driver' : `Driver PK ${100 + i}`, passwordHash],
    );
  }

  await AppDataSource.query(
    `INSERT INTO office_users (email, display_name, password_hash) VALUES ($1,$2,$3)`,
    [OFFICE_EMAIL, 'Office Demo', hashSync(OFFICE_PASSWORD, 10)],
  );

  console.log(`Seeding ${TODAY_STOPS} stops for today (the depot map set)...`);
  const today: SeedStop[] = [];
  driverIds.forEach((driverId, d) => {
    const count = d === driverIds.length - 1 ? TODAY_STOPS - STOPS_PER_DRIVER * (DRIVER_COUNT - 1) : STOPS_PER_DRIVER;
    for (let seq = 1; seq <= count; seq += 1) {
      // Position in the round decides time of day, with a little jitter so
      // the whole fleet does not move in lockstep.
      const through = (seq - 1) / Math.max(count - 1, 1);
      today.push(makeStop(driverId, seq, dayTimestamp(Math.min(through + rand() * 0.02, 1)), true));
    }
  });
  await insertStops(today);

  console.log(`Seeding ${PK_STOPS} stops for the Pakistan depot...`);
  // Its own array, deliberately. These used to be pushed onto `today`, which
  // had already been inserted on the line above, so the push went nowhere and
  // the Karachi depot was never seeded on a fresh install: the drivers existed
  // and their round did not.
  const pkToday: SeedStop[] = [];
  const pkPerDriver = Math.floor(PK_STOPS / PK_DRIVER_COUNT);
  pkDriverIds.forEach((driverId, d) => {
    const count = d === pkDriverIds.length - 1 ? PK_STOPS - pkPerDriver * (PK_DRIVER_COUNT - 1) : pkPerDriver;
    for (let seq = 1; seq <= count; seq += 1) {
      const through = (seq - 1) / Math.max(count - 1, 1);
      pkToday.push(
        makeStop(driverId, seq, dayTimestamp(Math.min(through + rand() * 0.02, 1)), true, 'pk'),
      );
    }
  });
  await insertStops(pkToday);

  console.log(`Seeding ${HISTORICAL_STOPS} historical stops with legacy pods rows...`);
  const historical: SeedStop[] = [];
  for (let i = 0; i < HISTORICAL_STOPS; i += 1) {
    const daysAgo = 1 + Math.floor(rand() * 30);
    const createdAt = new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString();
    historical.push(makeStop(pick(driverIds), 1 + (i % 150), createdAt, false));
  }
  await insertStops(historical);

  // Legacy pods exactly as v1 wrote them: boolean outcome, single photo URL.
  const CHUNK = 500;
  for (let i = 0; i < historical.length; i += CHUNK) {
    const chunk = historical.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((s, j) => {
      const delivered = rand() < 0.92;
      const base = j * 6;
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
      params.push(
        s.id,
        delivered,
        delivered && rand() < 0.7 ? `https://legacy-cdn.example.com/pods/${s.id}.jpg` : null,
        s.location,
        delivered ? (rand() < 0.3 ? 'left with resident' : null) : 'no answer, carded',
        s.createdAt,
      );
    });
    await AppDataSource.query(
      `INSERT INTO pods (stop_id, delivered, photo_url, location, note, created_at)
       VALUES ${values.join(',')} ON CONFLICT (stop_id) DO NOTHING`,
      params,
    );
  }

  // Both depots get a worked front-of-round, so the app, the maps and the
  // office dashboard all open on a day in progress rather than an empty one.
  // Karachi is worked slightly harder than London purely so the two rounds do
  // not look like copies of each other.
  await seedWorkedAttempts(driverIds, 'the London depot', 0.28);
  await seedWorkedAttempts(pkDriverIds, 'the Karachi depot', 0.35);

  const [stopCount] = (await AppDataSource.query(`SELECT count(*)::int AS n FROM stops`)) as Array<{ n: number }>;
  const [podCount] = (await AppDataSource.query(`SELECT count(*)::int AS n FROM pods`)) as Array<{ n: number }>;
  console.log(`Done. stops=${stopCount.n} pods=${podCount.n}`);
  console.log(`Test driver login:  ${TEST_DRIVER_REF} / ${TEST_DRIVER_PASSWORD}`);
  console.log(`Karachi driver:     ${PK_TEST_DRIVER_REF} / ${TEST_DRIVER_PASSWORD}`);
  console.log(`Office login:       ${OFFICE_EMAIL} / ${OFFICE_PASSWORD}`);

  await AppDataSource.destroy();
}

void main();
