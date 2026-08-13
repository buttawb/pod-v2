import * as Crypto from 'expo-crypto';
import { getDatabase } from './schema';
import { SUBSTANTIVE_DRAFT_SQL } from '../sync/drafts';
import {
  canTransition,
  FailureKind,
  MAX_AUTO_RETRIES,
  PhotoUploadState,
  SyncState,
  backoffDelayMs,
} from '../sync/state-machine';

export interface AttemptRow {
  client_attempt_id: string;
  stop_id: string;
  attempt_no: number;
  outcome: string | null;
  reason_code: string | null;
  neighbour_house_number: string | null;
  note: string | null;
  parcel_barcode: string | null;
  barcode_source: string | null;
  barcode_match: number | null;
  barcode_override_reason: string | null;
  retry_today: number;
  signature_path: string | null;
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  captured_at: string;
  captured_at_monotonic: number | null;
  driver_id: string;
  device_id: string;
  app_version: string;
  sync_state: SyncState;
  retry_count: number;
  next_retry_at: string | null;
  failure_kind: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  server_attempt_id: string | null;
  finalized_at: string | null;
  synced_at: string | null;
}

export interface PhotoRow {
  client_attempt_id: string;
  photo_index: number;
  kind: string;
  local_path: string;
  byte_size: number;
  upload_state: PhotoUploadState;
  retry_count: number;
  confirmed_at: string | null;
}

export async function createDraft(input: {
  stopId: string;
  driverId: string;
  deviceId: string;
  appVersion: string;
}): Promise<string> {
  const db = getDatabase();
  const clientAttemptId = Crypto.randomUUID();

  // Drafts are not attempts. Counting them numbers the driver's first real
  // attempt "3" after two capture screens that were opened and abandoned.
  const prior = await db.getFirstAsync<{ n: number }>(
    `SELECT count(*) AS n FROM attempts WHERE stop_id = ? AND sync_state <> 'draft'`,
    input.stopId,
  );

  await db.runAsync(
    `INSERT INTO attempts (client_attempt_id, stop_id, attempt_no, captured_at,
       captured_at_monotonic, driver_id, device_id, app_version, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    clientAttemptId,
    input.stopId,
    (prior?.n ?? 0) + 1,
    new Date().toISOString(),
    Math.round(performance.now()),
    input.driverId,
    input.deviceId,
    input.appVersion,
  );
  return clientAttemptId;
}

export async function getAttempt(clientAttemptId: string): Promise<AttemptRow | null> {
  return getDatabase().getFirstAsync<AttemptRow>(
    'SELECT * FROM attempts WHERE client_attempt_id = ?',
    clientAttemptId,
  );
}

export async function getPhotos(clientAttemptId: string): Promise<PhotoRow[]> {
  return getDatabase().getAllAsync<PhotoRow>(
    'SELECT * FROM attempt_photos WHERE client_attempt_id = ? ORDER BY photo_index',
    clientAttemptId,
  );
}

/**
 * The unfinished capture to resume at this stop, if there is one.
 *
 * Scoped by driver because handsets are shared and `updateDraft` never
 * rewrites `driver_id`: without this, driver B opening the stop would inherit
 * driver A's half-finished capture and submit it under A's name from B's
 * session.
 *
 * A draft with work in it wins over a newer empty one. Ordering by recency
 * alone made this disagree with the stop list, which asks "is there a draft
 * with anything in it" via the same predicate: the list showed an unfinished
 * badge while the detail screen offered a fresh Record attempt, because an
 * empty draft left behind by an older build sorted above the real one. Both
 * paths now read the same rule, which is what SUBSTANTIVE_DRAFT_SQL exists
 * for.
 */
export async function getDraftForStop(
  stopId: string,
  driverId: string,
): Promise<AttemptRow | null> {
  return getDatabase().getFirstAsync<AttemptRow>(
    `SELECT a.* FROM attempts a
     WHERE a.stop_id = ? AND a.driver_id = ? AND a.sync_state = 'draft'
     ORDER BY CASE WHEN ${SUBSTANTIVE_DRAFT_SQL} THEN 0 ELSE 1 END,
              a.captured_at DESC
     LIMIT 1`,
    stopId,
    driverId,
  );
}

/**
 * The file is already on disk before this row exists: file first, row
 * second, UI last. A kill between the write and the insert leaves an
 * orphan file (harmless); the reverse would leave a row pointing at
 * evidence that never existed.
 */
export async function addPhoto(input: {
  clientAttemptId: string;
  photoIndex: number;
  kind: 'photo' | 'signature';
  localPath: string;
  byteSize: number;
}): Promise<void> {
  await getDatabase().runAsync(
    `INSERT INTO attempt_photos (client_attempt_id, photo_index, kind, local_path, byte_size)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(client_attempt_id, photo_index) DO UPDATE SET
       local_path = excluded.local_path, byte_size = excluded.byte_size,
       upload_state = 'pending', retry_count = 0, confirmed_at = NULL`,
    input.clientAttemptId,
    input.photoIndex,
    input.kind,
    input.localPath,
    input.byteSize,
  );
}

export async function removePhoto(clientAttemptId: string, photoIndex: number): Promise<void> {
  // Only ever called on a draft: submitted evidence is immutable.
  await getDatabase().runAsync(
    `DELETE FROM attempt_photos
     WHERE client_attempt_id = ? AND photo_index = ?
       AND (SELECT sync_state FROM attempts WHERE client_attempt_id = ?) = 'draft'`,
    clientAttemptId,
    photoIndex,
    clientAttemptId,
  );
}

export async function updateDraft(
  clientAttemptId: string,
  fields: Partial<
    Pick<
      AttemptRow,
      | 'outcome'
      | 'reason_code'
      | 'neighbour_house_number'
      | 'note'
      | 'parcel_barcode'
      | 'barcode_source'
      | 'barcode_match'
      | 'barcode_override_reason'
      | 'retry_today'
      | 'signature_path'
      | 'lat'
      | 'lng'
      | 'gps_accuracy_m'
    >
  >,
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setters = keys.map((k) => `${k} = ?`).join(', ');
  await getDatabase().runAsync(
    `UPDATE attempts SET ${setters} WHERE client_attempt_id = ? AND sync_state = 'draft'`,
    ...keys.map((k) => (fields as Record<string, unknown>)[k] as never),
    clientAttemptId,
  );
}

/**
 * Finalize is the durability boundary: one conditioned UPDATE, committed
 * before the UI advances. The `sync_state = 'draft'` predicate makes a
 * double tap a no-op rather than a second submission, and a kill straight
 * after the commit still uploads on next launch.
 */
export async function finalizeAttempt(clientAttemptId: string): Promise<boolean> {
  const result = await getDatabase().runAsync(
    `UPDATE attempts
     SET sync_state = 'queued', finalized_at = ?, next_retry_at = NULL, retry_count = 0
     WHERE client_attempt_id = ? AND sync_state = 'draft'`,
    new Date().toISOString(),
    clientAttemptId,
  );
  return result.changes === 1;
}

/**
 * The database row is the only authority on current state.
 *
 * Callers used to pass the state they believed the attempt was in, read
 * from a row they had been holding across awaits. That row goes stale the
 * moment any phase advances, and a stale `from` silently matches zero rows:
 * the terminal transition to `synced` would no-op, leaving evidence the
 * server had already verified stuck on the device forever. So `from` is
 * read here, inside the same call that writes.
 */
export async function transitionTo(
  clientAttemptId: string,
  to: SyncState,
  extra: Partial<Record<string, string | number | null>> = {},
): Promise<boolean> {
  const attempt = await getAttempt(clientAttemptId);
  if (!attempt) return false;
  if (!canTransition(attempt.sync_state, to)) return false;

  const keys = Object.keys(extra);
  const setters = ['sync_state = ?', ...keys.map((k) => `${k} = ?`)].join(', ');
  const result = await getDatabase().runAsync(
    `UPDATE attempts SET ${setters} WHERE client_attempt_id = ? AND sync_state = ?`,
    to,
    ...keys.map((k) => extra[k] as never),
    clientAttemptId,
    attempt.sync_state,
  );
  return result.changes === 1;
}

/**
 * Scheduling a retry is bookkeeping, not a state change.
 *
 * Modelling it as one forced illegal self-transitions (attempt_acked back to
 * attempt_acked), which threw and took the whole sync worker down with it.
 * An attempt that is already in a workable state simply gets its backoff
 * updated; only the in-flight `submitting` state has to fall back to
 * `queued` so the worker will pick it up again.
 */
export async function scheduleRetry(
  clientAttemptId: string,
  errorCode: string,
  errorMessage: string,
  opts: { firstDelayMs?: number } = {},
): Promise<void> {
  const attempt = await getAttempt(clientAttemptId);
  if (!attempt) return;

  const retryCount = attempt.retry_count + 1;
  if (retryCount >= MAX_AUTO_RETRIES) {
    await markNeedsAttention(clientAttemptId, FailureKind.Stuck, errorCode, errorMessage);
    return;
  }

  // A short first delay for the case where we know we are early rather than
  // broken: the uploads returned 200 and the server has simply not caught up.
  // Jittered exponential backoff from the first attempt treats "ask again in a
  // moment" like a failure and can push the recheck minutes out.
  const delay =
    opts.firstDelayMs !== undefined && attempt.retry_count === 0
      ? opts.firstDelayMs
      : backoffDelayMs(retryCount);

  const backoff = {
    retry_count: retryCount,
    next_retry_at: new Date(Date.now() + delay).toISOString(),
    last_error_code: errorCode,
    last_error_message: errorMessage,
  };

  if (attempt.sync_state === SyncState.Submitting) {
    await transitionTo(clientAttemptId, SyncState.Queued, backoff);
    return;
  }
  await getDatabase().runAsync(
    `UPDATE attempts SET retry_count = ?, next_retry_at = ?, last_error_code = ?,
       last_error_message = ? WHERE client_attempt_id = ?`,
    backoff.retry_count,
    backoff.next_retry_at,
    backoff.last_error_code,
    backoff.last_error_message,
    clientAttemptId,
  );
}

/**
 * A failure that was not really the attempt's fault (offline, an expired
 * token, an expired presign). The attempt stays workable and burns no retry
 * budget; only the in-flight `submitting` state has to be released so the
 * worker can claim it again.
 */
export async function releaseForRetry(
  clientAttemptId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const attempt = await getAttempt(clientAttemptId);
  if (!attempt) return;

  if (attempt.sync_state === SyncState.Submitting) {
    await transitionTo(clientAttemptId, SyncState.Queued, {
      last_error_code: errorCode,
      last_error_message: errorMessage,
    });
    return;
  }
  await getDatabase().runAsync(
    `UPDATE attempts SET last_error_code = ?, last_error_message = ?
     WHERE client_attempt_id = ?`,
    errorCode,
    errorMessage,
    clientAttemptId,
  );
}

export async function markNeedsAttention(
  clientAttemptId: string,
  kind: FailureKind,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await transitionTo(clientAttemptId, SyncState.NeedsAttention, {
    failure_kind: kind,
    last_error_code: errorCode,
    last_error_message: errorMessage,
    next_retry_at: null,
  });
}

/** Manual retry resumes at whichever phase the attempt actually reached. */
export async function retryNow(clientAttemptId: string): Promise<void> {
  const attempt = await getAttempt(clientAttemptId);
  if (!attempt || attempt.sync_state !== SyncState.NeedsAttention) return;

  const resumeAt = attempt.server_attempt_id ? SyncState.AttemptAcked : SyncState.Queued;
  await transitionTo(clientAttemptId, resumeAt, {
    retry_count: 0,
    next_retry_at: null,
    failure_kind: null,
    last_error_code: null,
    last_error_message: null,
  });
  await getDatabase().runAsync(
    `UPDATE attempt_photos SET upload_state = 'pending', retry_count = 0
     WHERE client_attempt_id = ? AND upload_state <> 'confirmed'`,
    clientAttemptId,
  );
}

export async function setPhotoState(
  clientAttemptId: string,
  photoIndex: number,
  state: PhotoUploadState,
  extra: { confirmed_at?: string } = {},
): Promise<void> {
  await getDatabase().runAsync(
    `UPDATE attempt_photos SET upload_state = ?, confirmed_at = COALESCE(?, confirmed_at)
     WHERE client_attempt_id = ? AND photo_index = ?`,
    state,
    extra.confirmed_at ?? null,
    clientAttemptId,
    photoIndex,
  );
}

/**
 * Next attempt the worker may act on, oldest capture first.
 *
 * `skip` holds the rows already handled in this run, so one attempt that
 * cannot progress does not block every attempt queued behind it.
 */
export async function claimNextWorkable(skip: Set<string> = new Set()): Promise<AttemptRow | null> {
  const skipped = [...skip];
  const placeholders = skipped.map(() => '?').join(',');
  return getDatabase().getFirstAsync<AttemptRow>(
    `SELECT * FROM attempts
     WHERE sync_state IN ('queued', 'attempt_acked', 'uploading_media')
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ${skipped.length > 0 ? `AND client_attempt_id NOT IN (${placeholders})` : ''}
     ORDER BY finalized_at ASC
     LIMIT 1`,
    new Date().toISOString(),
    ...skipped,
  );
}

export interface SyncCounts {
  onDevice: number;
  sending: number;
  uploading: number;
  needsAttention: number;
  synced: number;
}

/**
 * The banner's numbers.
 *
 * Two things were wrong here. `uploading` counted attempts, so a stop with
 * four photos still in flight read as "syncing 1 attempt" and the driver had
 * no idea how much was actually left to send; it now counts the photos, which
 * is what the time is being spent on. And the whole query was scoped by
 * neither driver nor day, so on a shared handset the previous driver's
 * quarantined backlog was counted into this driver's banner, along with
 * anything left over from earlier days.
 */
export async function syncCounts(): Promise<SyncCounts> {
  const row = await getDatabase().getFirstAsync<Record<string, number>>(
    `WITH mine AS (
       SELECT * FROM attempts
        WHERE driver_id = (SELECT value FROM sync_meta WHERE key = 'driver_id')
     )
     SELECT
       (SELECT count(*) FROM mine WHERE sync_state = 'queued')              AS onDevice,
       (SELECT count(*) FROM mine WHERE sync_state = 'submitting')          AS sending,
       (SELECT count(*) FROM attempt_photos p
          JOIN mine a ON a.client_attempt_id = p.client_attempt_id
         WHERE a.sync_state IN ('attempt_acked','uploading_media')
           AND p.upload_state <> 'confirmed')                               AS uploading,
       (SELECT count(*) FROM mine WHERE sync_state = 'needs_attention')     AS needsAttention,
       (SELECT count(*) FROM mine WHERE sync_state = 'synced')              AS synced`,
  );
  return {
    onDevice: row?.onDevice ?? 0,
    sending: row?.sending ?? 0,
    uploading: row?.uploading ?? 0,
    needsAttention: row?.needsAttention ?? 0,
    synced: row?.synced ?? 0,
  };
}
