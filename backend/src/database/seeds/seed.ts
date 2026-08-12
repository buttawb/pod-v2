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
}

function makeStop(driverId: string, sequence: number, createdAt: string, withCoords: boolean): SeedStop {
  const [outward, cLat, cLng] = DISTRICTS[Math.floor(rand() * DISTRICTS.length)];
  const lat = cLat + gaussian() * 0.008;
  const lng = cLng + gaussian() * 0.012;
  const inward = `${1 + Math.floor(rand() * 9)}${'ABDEFGHJLNPQRSTUWXYZ'[Math.floor(rand() * 20)]}${'ABDEFGHJLNPQRSTUWXYZ'[Math.floor(rand() * 20)]}`;
  return {
    id: randomUUID(),
    driverId,
    address: `${1 + Math.floor(rand() * 240)} ${pick(STREET_NAMES)}`,
    postcode: `${outward} ${inward}`,
    location: `${lat.toFixed(4)},${lng.toFixed(4)}`,
    sequence,
    createdAt,
    // Historical (v1-era) stops carry ONLY the legacy location string;
    // parsing them into lat/lng is the backfill script's job.
    lat: withCoords ? lat : null,
    lng: withCoords ? lng : null,
  };
}

async function insertStops(stops: SeedStop[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < stops.length; i += CHUNK) {
    const chunk = stops.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((s, j) => {
      const base = j * 9;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`,
      );
      params.push(s.id, s.driverId, s.address, s.postcode, s.location, s.sequence, s.createdAt, s.lat, s.lng);
    });
    await AppDataSource.query(
      `INSERT INTO stops (id, driver_id, address, postcode, location, sequence, created_at, lat, lng)
       VALUES ${values.join(',')} ON CONFLICT (id) DO NOTHING`,
      params,
    );
  }
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
  await AppDataSource.query(
    `INSERT INTO office_users (email, display_name, password_hash) VALUES ($1,$2,$3)`,
    [OFFICE_EMAIL, 'Office Demo', hashSync(OFFICE_PASSWORD, 10)],
  );

  console.log(`Seeding ${TODAY_STOPS} stops for today (the depot map set)...`);
  const today: SeedStop[] = [];
  const todayIso = new Date().toISOString();
  driverIds.forEach((driverId, d) => {
    const count = d === driverIds.length - 1 ? TODAY_STOPS - STOPS_PER_DRIVER * (DRIVER_COUNT - 1) : STOPS_PER_DRIVER;
    for (let seq = 1; seq <= count; seq += 1) {
      today.push(makeStop(driverId, seq, todayIso, true));
    }
  });
  await insertStops(today);

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

  const [stopCount] = (await AppDataSource.query(`SELECT count(*)::int AS n FROM stops`)) as Array<{ n: number }>;
  const [podCount] = (await AppDataSource.query(`SELECT count(*)::int AS n FROM pods`)) as Array<{ n: number }>;
  console.log(`Done. stops=${stopCount.n} pods=${podCount.n}`);
  console.log(`Test driver login:  ${TEST_DRIVER_REF} / ${TEST_DRIVER_PASSWORD}`);
  console.log(`Office login:       ${OFFICE_EMAIL} / ${OFFICE_PASSWORD}`);

  await AppDataSource.destroy();
}

void main();
