import * as SQLite from 'expo-sqlite';

/**
 * The device database is the system of record until the server confirms
 * otherwise. WAL means a process kill can never lose or corrupt a committed
 * transaction; synchronous=NORMAL keeps rapid capture writes free of fsync
 * jank, and the only exposure it leaves is OS-level power loss (a phone
 * quiesces on battery death), not the force-quit case we actually target.
 */
let db: SQLite.SQLiteDatabase | null = null;

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;

  db = await SQLite.openDatabaseAsync('pod-v2.db');
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  await migrate(db);
  return db;
}

export function getDatabase(): SQLite.SQLiteDatabase {
  if (!db) throw new Error('Database not opened; call openDatabase() during boot');
  return db;
}

async function migrate(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    -- ---- Server-owned cache: replaceable, never holds unsent work ----
    CREATE TABLE IF NOT EXISTS stops (
      stop_id        TEXT PRIMARY KEY,
      route_date     TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      address        TEXT NOT NULL,
      postcode       TEXT NOT NULL,
      lat            REAL,
      lng            REAL,
      status         TEXT NOT NULL DEFAULT 'pending',
      removed        INTEGER NOT NULL DEFAULT 0,
      -- What dispatch says should be at this door, for the capture-time check.
      expected_barcode TEXT,
      -- Server-derived: is this stop still the driver's work today?
      live_today     INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stops_route ON stops(route_date, seq);

    -- ---- Evidence: device-owned, sacred, never bulk-deleted ----
    CREATE TABLE IF NOT EXISTS attempts (
      client_attempt_id      TEXT PRIMARY KEY,
      stop_id                TEXT NOT NULL REFERENCES stops(stop_id),
      attempt_no             INTEGER NOT NULL DEFAULT 1,
      outcome                TEXT,
      reason_code            TEXT,
      neighbour_house_number TEXT,
      note                   TEXT,
      parcel_barcode         TEXT,
      barcode_source         TEXT,
      -- Did the scan match what dispatch expected? NULL means nothing to
      -- compare against, which is not the same as a mismatch.
      barcode_match          INTEGER,
      barcode_override_reason TEXT,
      -- Carded and no-access only: the driver is coming back today.
      retry_today            INTEGER NOT NULL DEFAULT 0,
      signature_path         TEXT,
      lat                    REAL,
      lng                    REAL,
      gps_accuracy_m         REAL,
      captured_at            TEXT NOT NULL,
      -- elapsedRealtime at capture: inconsistency with the wall clock later
      -- exposes a device clock that was changed between capture and submit.
      captured_at_monotonic  INTEGER,
      driver_id              TEXT NOT NULL,
      device_id              TEXT NOT NULL,
      app_version            TEXT NOT NULL,

      sync_state             TEXT NOT NULL DEFAULT 'draft',
      retry_count            INTEGER NOT NULL DEFAULT 0,
      next_retry_at          TEXT,
      failure_kind           TEXT,
      last_error_code        TEXT,
      last_error_message     TEXT,
      server_attempt_id      TEXT,
      finalized_at           TEXT,
      synced_at              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_stop  ON attempts(stop_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_queue ON attempts(sync_state, next_retry_at);

    CREATE TABLE IF NOT EXISTS attempt_photos (
      client_attempt_id TEXT NOT NULL REFERENCES attempts(client_attempt_id),
      photo_index       INTEGER NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'photo',
      local_path        TEXT NOT NULL,
      byte_size         INTEGER NOT NULL,
      upload_state      TEXT NOT NULL DEFAULT 'pending',
      retry_count       INTEGER NOT NULL DEFAULT 0,
      confirmed_at      TEXT,
      PRIMARY KEY (client_attempt_id, photo_index)
    );
    CREATE INDEX IF NOT EXISTS idx_photos_state ON attempt_photos(upload_state);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await upgrade(database);
}

/**
 * Column additions for databases that already exist on a driver's phone.
 *
 * `CREATE TABLE IF NOT EXISTS` above is a no-op once a table is there, so a
 * column added to it reaches new installs only. Every existing handset would
 * run new code against an old table and fail on the first read of a column
 * that is not there. Dropping and recreating is not available to us: that
 * database holds unsent evidence, and there is no version of this product
 * where an upgrade deletes a delivery the driver has already made.
 *
 * So: PRAGMA user_version as the schema version, and one numbered step per
 * change. SQLite's ALTER TABLE ADD COLUMN rewrites no rows, so this stays fast
 * on a full day's data. Steps must be append-only and must never be edited
 * once shipped, because a phone that has run step 2 will never run it again.
 */
const SCHEMA_VERSION = 1;

async function upgrade(database: SQLite.SQLiteDatabase): Promise<void> {
  const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  if (current < 1) {
    // A fresh install already has these from the CREATE above, so each one is
    // allowed to fail as "duplicate column" and no other way.
    await addColumn(database, 'attempts', 'retry_today', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn(database, 'attempts', 'barcode_match', 'INTEGER');
    await addColumn(database, 'attempts', 'barcode_override_reason', 'TEXT');
    await addColumn(database, 'stops', 'expected_barcode', 'TEXT');
    await addColumn(database, 'stops', 'live_today', 'INTEGER NOT NULL DEFAULT 1');
  }

  await database.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

async function addColumn(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  try {
    await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    // Only the already-present case is survivable. Anything else means the
    // schema is not what this build expects, and continuing would corrupt
    // reads in ways that surface much later.
    if (!/duplicate column/i.test((err as Error).message)) throw err;
  }
}

export async function getMeta(key: string): Promise<string | null> {
  const row = await getDatabase().getFirstAsync<{ value: string }>(
    'SELECT value FROM sync_meta WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await getDatabase().runAsync(
    'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    key,
    value,
    value,
  );
}
