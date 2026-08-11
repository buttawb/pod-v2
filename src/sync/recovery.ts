import { deleteFile, fileExists } from '../capture/media';
import { getDatabase } from '../db/schema';
import { FailureKind, PhotoUploadState, SyncState } from './state-machine';

/**
 * Cold-start crash recovery, run before the UI renders.
 *
 * The invariant it restores: any phase that was mid-flight when the process
 * died is returned to a workable state, and any anomaly becomes a visible
 * `needs_attention` row - never a silent skip and never a deletion.
 */
export async function runRecoverySweep(): Promise<{ requeued: number; flagged: number }> {
  const db = getDatabase();

  // A request that was in flight when we died: re-send it. Every endpoint
  // is idempotent, so the worst case is a duplicate request, not a
  // duplicate record.
  const requeued = await db.runAsync(
    `UPDATE attempts SET sync_state = 'queued', next_retry_at = NULL
     WHERE sync_state = 'submitting'`,
  );

  await db.runAsync(
    `UPDATE attempt_photos SET upload_state = 'pending' WHERE upload_state = 'uploading'`,
  );

  // Evidence whose backing file has vanished (OS purge, "clear storage")
  // must be surfaced, not quietly uploaded as an empty attempt.
  const unsyncedPhotos = await db.getAllAsync<{ client_attempt_id: string; local_path: string }>(
    `SELECT ap.client_attempt_id, ap.local_path
     FROM attempt_photos ap
     JOIN attempts a ON a.client_attempt_id = ap.client_attempt_id
     WHERE a.sync_state NOT IN ('synced', 'needs_attention')`,
  );

  const brokenAttempts = new Set<string>();
  for (const photo of unsyncedPhotos) {
    if (!fileExists(photo.local_path)) brokenAttempts.add(photo.client_attempt_id);
  }

  for (const clientAttemptId of brokenAttempts) {
    await db.runAsync(
      `UPDATE attempts
       SET sync_state = 'needs_attention', failure_kind = ?, last_error_code = ?,
           last_error_message = ?, next_retry_at = NULL
       WHERE client_attempt_id = ?`,
      FailureKind.EvidenceMissing,
      'EVIDENCE_FILE_MISSING',
      'An evidence file is missing from this device',
      clientAttemptId,
    );
  }

  return { requeued: requeued.changes, flagged: brokenAttempts.size };
}

/**
 * Storage pressure valve: only fully synced evidence older than the window
 * is removed, and only after the server confirmed every object. Nothing
 * unsent is ever touched.
 */
export async function pruneSyncedEvidence(retentionDays = 7): Promise<number> {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000).toISOString();

  const stale = await db.getAllAsync<{ client_attempt_id: string; local_path: string }>(
    `SELECT ap.client_attempt_id, ap.local_path
     FROM attempt_photos ap
     JOIN attempts a ON a.client_attempt_id = ap.client_attempt_id
     WHERE a.sync_state = ? AND a.synced_at < ? AND ap.upload_state = ?`,
    SyncState.Synced,
    cutoff,
    PhotoUploadState.Confirmed,
  );

  for (const photo of stale) {
    deleteFile(photo.local_path);
  }
  await db.runAsync(
    `DELETE FROM attempt_photos
     WHERE client_attempt_id IN (
       SELECT client_attempt_id FROM attempts WHERE sync_state = ? AND synced_at < ?
     )`,
    SyncState.Synced,
    cutoff,
  );

  return stale.length;
}
