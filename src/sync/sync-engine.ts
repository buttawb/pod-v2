import NetInfo from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import { ApiError, apiRequest, NetworkError, uploadToS3, APP_VERSION } from '../api/client';
import { fileExists } from '../capture/media';
import {
  claimNextWorkable,
  getAttempt,
  getPhotos,
  markNeedsAttention,
  releaseForRetry,
  scheduleRetry,
  setPhotoState,
  transitionTo,
  type AttemptRow,
  type PhotoRow,
} from '../db/attempts-repo';
import { getSessionState, SessionState } from '../auth/session';
import {
  classifyFailure,
  FailureClass,
  FailureKind,
  PhotoUploadState,
  SyncState,
  WORKABLE_STATES,
} from './state-machine';

interface UploadTarget {
  kind: 'photo' | 'signature';
  photoIndex?: number;
  s3Key: string;
  url: string;
}

interface CreateAttemptResponse {
  attemptId: string;
  clientAttemptId: string;
  evidenceStatus: string;
  deduplicated: boolean;
  uploads: UploadTarget[];
}

interface FinalizeResponse {
  attemptComplete: boolean;
  evidenceStatus: string;
}

const PARALLEL_UPLOADS = 2;
const HEARTBEAT_MS = 60_000;
/** submit -> upload -> finalize, with slack. A bound, not a schedule. */
const MAX_PHASES_PER_ATTEMPT = 4;

type Listener = () => void;

class SyncEngine {
  private running = false;
  private online = true;
  private generation = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();

  /** UI subscribes here; every state change re-derives badges from SQLite. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  start(): () => void {
    const netSub = NetInfo.addEventListener((state) => {
      const nowOnline = Boolean(state.isConnected);
      const cameOnline = !this.online && nowOnline;
      this.online = nowOnline;
      // The offline -> online edge is the highest-value trigger there is.
      if (cameOnline) void this.kick();
      this.notify();
    });

    const appSub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') void this.kick();
    });

    this.heartbeat = setInterval(() => void this.kick(), HEARTBEAT_MS);

    return () => {
      netSub();
      appSub.remove();
      if (this.heartbeat) clearInterval(this.heartbeat);
    };
  }

  isOnline(): boolean {
    return this.online;
  }

  /**
   * Reentrancy-safe entry point. One serial worker: 150 stops a day is tiny
   * volume, serial keeps uploads in chronological order for dispatch, and
   * it means exactly one writer ever touches sync_state.
   */
  async kick(): Promise<void> {
    if (this.running) return;
    if (!this.online) return;
    if ((await getSessionState()) === SessionState.NeedsReauth) return;

    this.running = true;
    const generation = (this.generation += 1);
    // One attempt that cannot progress must never strand the ones behind it:
    // the queue is claimed oldest-first, so a single stuck row would
    // otherwise block a whole day of evidence. Rows touched in this run are
    // skipped rather than re-claimed, and the run ends when nothing new is
    // left instead of at the first failure.
    const touched = new Set<string>();
    try {
      for (;;) {
        if (generation !== this.generation) break;
        const attempt = await claimNextWorkable(touched);
        if (!attempt) break;
        touched.add(attempt.client_attempt_id);

        try {
          // Drive this attempt through as many phases as it will go: submit,
          // upload, finalize. Stopping after one phase would leave a fresh
          // capture waiting for the next trigger before its photos moved.
          let current: AttemptRow | null = attempt;
          for (let phase = 0; phase < MAX_PHASES_PER_ATTEMPT && current; phase += 1) {
            const progressed = await this.processAttempt(current);
            if (!progressed) break;
            current = await getAttempt(attempt.client_attempt_id);
            if (!current || !WORKABLE_STATES.includes(current.sync_state)) break;
          }
        } catch (err) {
          // An unexpected throw must become a visible, driver-actionable
          // row, never a silent stall of the entire queue.
          await markNeedsAttention(
            attempt.client_attempt_id,
            FailureKind.Stuck,
            'SYNC_INTERNAL',
            err instanceof Error ? err.message : 'Internal sync error',
          ).catch(() => undefined);
        }
        this.notify();
      }
    } finally {
      this.running = false;
    }
  }

  private async processAttempt(attempt: AttemptRow): Promise<boolean> {
    if (attempt.sync_state === SyncState.Queued) return this.submitAttempt(attempt);
    return this.uploadMedia(attempt);
  }

  private async submitAttempt(attempt: AttemptRow): Promise<boolean> {
    const photos = await getPhotos(attempt.client_attempt_id);
    const missing = await this.findMissingFiles(photos);
    if (missing.length > 0) {
      // Never pretend evidence exists. The driver is told exactly which
      // photo is gone and can capture a fresh attempt.
      await markNeedsAttention(
        attempt.client_attempt_id,
        FailureKind.EvidenceMissing,
        'EVIDENCE_FILE_MISSING',
        `${missing.length} evidence file(s) missing from this device`,
      );
      return true;
    }

    // Persist the phase BEFORE the network call: a kill mid-flight is
    // recovered by the startup sweep, and the re-send is idempotent.
    if (!(await transitionTo(attempt.client_attempt_id, SyncState.Submitting))) {
      return true;
    }

    const body = {
      clientAttemptId: attempt.client_attempt_id,
      stopId: attempt.stop_id,
      outcome: attempt.outcome,
      parcelBarcode: attempt.parcel_barcode ?? undefined,
      barcodeSource: attempt.parcel_barcode ? (attempt.barcode_source ?? 'manual') : undefined,
      neighbourHouseNumber: attempt.neighbour_house_number ?? undefined,
      reasonCode: attempt.reason_code ?? undefined,
      note: attempt.note ?? undefined,
      lat: attempt.lat ?? 0,
      lng: attempt.lng ?? 0,
      gpsAccuracyM: attempt.gps_accuracy_m ?? undefined,
      capturedAt: attempt.captured_at,
      appVersion: attempt.app_version || APP_VERSION,
      photos: photos
        .filter((p) => p.kind === 'photo')
        .map((p) => ({ index: p.photo_index, sizeBytes: p.byte_size })),
      signature: photos.find((p) => p.kind === 'signature')
        ? { sizeBytes: photos.find((p) => p.kind === 'signature')!.byte_size }
        : undefined,
    };

    try {
      const result = await apiRequest<CreateAttemptResponse>('/api/v2/attempts', {
        method: 'POST',
        body,
      });
      // A replay is success: the question is "does the server durably have
      // this?", not "was this the first delivery?".
      await transitionTo(attempt.client_attempt_id, SyncState.AttemptAcked, {
        server_attempt_id: result.attemptId,
        retry_count: 0,
        next_retry_at: null,
        last_error_code: null,
        last_error_message: null,
      });
      return true;
    } catch (err) {
      await this.handleFailure(attempt, err);
      return false;
    }
  }

  private async uploadMedia(attempt: AttemptRow): Promise<boolean> {
    const photos = await getPhotos(attempt.client_attempt_id);
    const outstanding = photos.filter((p) => p.upload_state !== PhotoUploadState.Confirmed);

    if (outstanding.length === 0) return this.finalize(attempt);

    if (attempt.sync_state === SyncState.AttemptAcked) {
      await transitionTo(attempt.client_attempt_id, SyncState.UploadingMedia);
    }

    let targets: UploadTarget[];
    try {
      // URLs are never persisted - they expire. State is; URLs are re-asked for.
      targets = await apiRequest<UploadTarget[]>(
        `/api/v2/attempts/${attempt.client_attempt_id}/upload-urls`,
        { method: 'POST' },
      );
    } catch (err) {
      await this.handleFailure(attempt, err);
      return false;
    }

    for (let i = 0; i < outstanding.length; i += PARALLEL_UPLOADS) {
      const batch = outstanding.slice(i, i + PARALLEL_UPLOADS);
      const results = await Promise.all(
        batch.map((photo) => this.uploadOne(attempt, photo, targets)),
      );
      if (results.some((ok) => !ok)) return false;
    }

    return this.finalize(attempt);
  }

  private async uploadOne(
    attempt: AttemptRow,
    photo: PhotoRow,
    targets: UploadTarget[],
  ): Promise<boolean> {
    const target = targets.find((t) =>
      photo.kind === 'signature' ? t.kind === 'signature' : t.photoIndex === photo.photo_index,
    );
    // No target means the server already holds it: nothing owed.
    if (!target) {
      await setPhotoState(attempt.client_attempt_id, photo.photo_index, PhotoUploadState.Confirmed, {
        confirmed_at: new Date().toISOString(),
      });
      return true;
    }

    if (!fileExists(photo.local_path)) {
      await markNeedsAttention(
        attempt.client_attempt_id,
        FailureKind.EvidenceMissing,
        'EVIDENCE_FILE_MISSING',
        'An evidence file is missing from this device',
      );
      return false;
    }

    await setPhotoState(attempt.client_attempt_id, photo.photo_index, PhotoUploadState.Uploading);
    try {
      await uploadToS3(
        target.url,
        photo.local_path,
        photo.kind === 'signature' ? 'image/png' : 'image/jpeg',
        photo.byte_size,
      );
      // Deterministic S3 keys make a re-upload after a lost response an
      // overwrite of identical bytes, never a duplicate object.
      await setPhotoState(attempt.client_attempt_id, photo.photo_index, PhotoUploadState.Uploaded);
      return true;
    } catch (err) {
      await setPhotoState(attempt.client_attempt_id, photo.photo_index, PhotoUploadState.Pending);
      await this.handleFailure(attempt, err);
      return false;
    }
  }

  /**
   * The server verifies every declared object against S3 itself. Only its
   * answer may move us to `synced` - that is what makes "On server" honest.
   */
  private async finalize(attempt: AttemptRow): Promise<boolean> {
    try {
      const result = await apiRequest<FinalizeResponse>(
        `/api/v2/attempts/${attempt.client_attempt_id}/finalize`,
        { method: 'POST' },
      );

      if (!result.attemptComplete) {
        // Server is still owed something; come back after a backoff. The
        // retry budget applies here too, so an object the server will never
        // accept escalates to the driver instead of looping forever.
        await scheduleRetry(
          attempt.client_attempt_id,
          'MEDIA_INCOMPLETE',
          'Server has not verified all evidence yet',
        );
        return false;
      }

      const photos = await getPhotos(attempt.client_attempt_id);
      for (const photo of photos) {
        await setPhotoState(
          attempt.client_attempt_id,
          photo.photo_index,
          PhotoUploadState.Confirmed,
          { confirmed_at: new Date().toISOString() },
        );
      }
      await transitionTo(attempt.client_attempt_id, SyncState.Synced, {
        synced_at: new Date().toISOString(),
        next_retry_at: null,
        last_error_code: null,
        last_error_message: null,
      });
      return true;
    } catch (err) {
      await this.handleFailure(attempt, err);
      return false;
    }
  }

  private async handleFailure(attempt: AttemptRow, err: unknown): Promise<void> {
    const signal = {
      httpStatus: err instanceof ApiError ? err.status : undefined,
      networkError: err instanceof NetworkError,
      timedOut: err instanceof NetworkError && err.timedOut,
      online: this.online,
    };
    const code = err instanceof ApiError ? (err.code ?? `HTTP_${err.status}`) : 'NETWORK';
    const message = err instanceof Error ? err.message : 'Unknown error';

    switch (classifyFailure(signal)) {
      case FailureClass.Offline:
      case FailureClass.AuthRefresh:
        // Nothing was really attempted. Leave the attempt workable and burn
        // no retry budget; only the in-flight `submitting` state needs
        // releasing so the worker can claim it again.
        await releaseForRetry(attempt.client_attempt_id, code, message);
        break;

      case FailureClass.RefreshUrls:
        // An expired presign is fixable by re-requesting URLs, but a
        // persistently rejected one is a real failure: it goes on the retry
        // budget so it escalates to the driver instead of spinning forever.
        await scheduleRetry(attempt.client_attempt_id, code, message);
        break;

      case FailureClass.Permanent:
      case FailureClass.Recompress:
        // Retrying a validation error forever is the definition of a poison
        // message. Park it, keep everything, tell the driver plainly.
        await markNeedsAttention(
          attempt.client_attempt_id,
          FailureKind.Rejected,
          code,
          message,
        );
        break;

      default:
        await scheduleRetry(attempt.client_attempt_id, code, message);
    }
  }

  private async findMissingFiles(photos: PhotoRow[]): Promise<PhotoRow[]> {
    return photos.filter((photo) => !fileExists(photo.local_path));
  }
}

export const syncEngine = new SyncEngine();
