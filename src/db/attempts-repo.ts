import * as Crypto from 'expo-crypto';
import { getDatabase } from './schema';
import {
  assertTransition,
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

  const prior = await db.getFirstAsync<{ n: number }>(
    'SELECT count(*) AS n FROM attempts WHERE stop_id = ?',
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

export async function transition(
  clientAttemptId: string,
  from: SyncState,
  to: SyncState,
  extra: Partial<Record<string, string | number | null>> = {},
): Promise<boolean> {
  assertTransition(from, to);
  const keys = Object.keys(extra);
  const setters = ['sync_state = ?', ...keys.map((k) => `${k} = ?`)].join(', ');
  const result = await getDatabase().runAsync(
    `UPDATE attempts SET ${setters} WHERE client_attempt_id = ? AND sync_state = ?`,
    to,
    ...keys.map((k) => extra[k] as never),
    clientAttemptId,
    from,
  );
  return result.changes === 1;
}

export async function scheduleRetry(
  clientAttemptId: string,
  from: SyncState,
  to: SyncState,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const attempt = await getAttempt(clientAttemptId);
  if (!attempt) return;

  const retryCount = attempt.retry_count + 1;
  if (retryCount >= MAX_AUTO_RETRIES) {
    await markNeedsAttention(clientAttemptId, from, FailureKind.Stuck, errorCode, errorMessage);
    return;
  }
  await transition(clientAttemptId, from, to, {
    retry_count: retryCount,
    next_retry_at: new Date(Date.now() + backoffDelayMs(retryCount)).toISOString(),
    last_error_code: errorCode,
    last_error_message: errorMessage,
  });
}

export async function markNeedsAttention(
  clientAttemptId: string,
  from: SyncState,
  kind: FailureKind,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await transition(clientAttemptId, from, SyncState.NeedsAttention, {
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
  await transition(clientAttemptId, SyncState.NeedsAttention, resumeAt, {
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

/** Next attempt the worker may act on, oldest capture first. */
export async function claimNextWorkable(): Promise<AttemptRow | null> {
  return getDatabase().getFirstAsync<AttemptRow>(
    `SELECT * FROM attempts
     WHERE sync_state IN ('queued', 'attempt_acked', 'uploading_media')
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY finalized_at ASC
     LIMIT 1`,
    new Date().toISOString(),
  );
}

export interface SyncCounts {
  onDevice: number;
  sending: number;
  uploading: number;
  needsAttention: number;
  synced: number;
}

export async function syncCounts(): Promise<SyncCounts> {
  const row = await getDatabase().getFirstAsync<Record<string, number>>(
    `SELECT
       SUM(sync_state = 'queued')                                  AS onDevice,
       SUM(sync_state = 'submitting')                              AS sending,
       SUM(sync_state IN ('attempt_acked', 'uploading_media'))     AS uploading,
       SUM(sync_state = 'needs_attention')                         AS needsAttention,
       SUM(sync_state = 'synced')                                  AS synced
     FROM attempts`,
  );
  return {
    onDevice: row?.onDevice ?? 0,
    sending: row?.sending ?? 0,
    uploading: row?.uploading ?? 0,
    needsAttention: row?.needsAttention ?? 0,
    synced: row?.synced ?? 0,
  };
}
