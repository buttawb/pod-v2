import { deleteFile, fileExists } from '../capture/media';
import { getDatabase } from '../db/schema';
import { FailureKind, PhotoUploadState, SyncState } from './state-machine';
import { planDraftSweep, type DraftEntry } from './drafts';
import type { AttemptRow, PhotoRow } from '../db/attempts-repo';

/**
 * Cold-start crash recovery, run before the UI renders.
 *
 * The invariant it restores: any phase that was mid-flight when the process
 * died is returned to a workable state, and any anomaly becomes a visible
 * `needs_attention` row - never a silent skip and never a deletion.
 */
export async function runRecoverySweep(): Promise<{
  requeued: number;
  flagged: number;
  resumable: number;
  discarded: number;
}> {
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
  //
  // Drafts are excluded because a draft is not an attempt yet. The UPDATE
  // below writes sync_state directly, so it would push draft straight to
  // needs_attention, which the transition table forbids; the driver would
  // then see an unfinished capture as a real failed attempt, and "Retry now"
  // would queue it for submission with a NULL outcome. sweepDrafts() handles
  // a draft's missing files instead, by dropping the photo row.
  const unsyncedPhotos = await db.getAllAsync<{ client_attempt_id: string; local_path: string }>(
    `SELECT ap.client_attempt_id, ap.local_path
     FROM attempt_photos ap
     JOIN attempts a ON a.client_attempt_id = ap.client_attempt_id
     WHERE a.sync_state NOT IN ('draft', 'synced', 'needs_attention')`,
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

  const drafts = await sweepDrafts();
  return { requeued: requeued.changes, flagged: brokenAttempts.size, ...drafts };
}

/**
 * Drafts outlive the process now, so startup has to decide which ones are
 * real work.
 *
 * A draft holding evidence is the attempt the driver was part-way through
 * when the phone died, and it is left exactly as it is. A draft holding
 * nothing is the residue of a capture screen that was opened and backed out
 * of, and offering that back would be noise. Only `sync_state = 'draft'` rows
 * are read, and every write below repeats the predicate, so a row that
 * finalized between the SELECT and the DELETE is skipped rather than lost.
 */
async function sweepDrafts(): Promise<{ resumable: number; discarded: number }> {
  const db = getDatabase();

  const photos = await db.getAllAsync<PhotoRow>(
    `SELECT p.* FROM attempt_photos p
     JOIN attempts a ON a.client_attempt_id = p.client_attempt_id
     WHERE a.sync_state = 'draft'`,
  );

  const byAttempt = new Map<string, PhotoRow[]>();
  for (const photo of photos) {
    if (fileExists(photo.local_path)) {
      const existing = byAttempt.get(photo.client_attempt_id);
      if (existing) existing.push(photo);
      else byAttempt.set(photo.client_attempt_id, [photo]);
      continue;
    }

    // The file is gone, so the row is a claim with nothing behind it. Leaving
    // it would let the submit-time evidence rules count a photo that cannot
    // be uploaded and wave the attempt through.
    await db.runAsync(
      `DELETE FROM attempt_photos
       WHERE client_attempt_id = ? AND photo_index = ?
         AND (SELECT sync_state FROM attempts WHERE client_attempt_id = ?) = 'draft'`,
      photo.client_attempt_id,
      photo.photo_index,
      photo.client_attempt_id,
    );
    if (photo.kind === 'signature') {
      // signature_path is a second copy of the same claim, and it is the one
      // the capture screen validates against.
      await db.runAsync(
        `UPDATE attempts SET signature_path = NULL
         WHERE client_attempt_id = ? AND sync_state = 'draft'`,
        photo.client_attempt_id,
      );
    }
  }

  // Read the rows after the cleanup above, so a draft whose only evidence was
  // a vanished signature is correctly seen as blank.
  const rows = await db.getAllAsync<AttemptRow>(
    `SELECT * FROM attempts WHERE sync_state = 'draft'`,
  );
  const entries: DraftEntry[] = rows.map((row) => ({
    row,
    photos: byAttempt.get(row.client_attempt_id) ?? [],
  }));
  const plan = planDraftSweep(entries);

  for (const clientAttemptId of plan.discard) {
    // Photos first: the foreign key points that way. A blank draft has none
    // by definition, so this only clears rows whose file had already gone.
    await db.runAsync(
      `DELETE FROM attempt_photos
       WHERE client_attempt_id = ?
         AND (SELECT sync_state FROM attempts WHERE client_attempt_id = ?) = 'draft'`,
      clientAttemptId,
      clientAttemptId,
    );
    await db.runAsync(
      `DELETE FROM attempts WHERE client_attempt_id = ? AND sync_state = 'draft'`,
      clientAttemptId,
    );
  }

  return { resumable: plan.resume.length, discarded: plan.discard.length };
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
