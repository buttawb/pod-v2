/**
 * The sync engine is a state machine over durable SQLite rows, not an
 * in-memory queue. Every transition below is persisted before the network
 * call it enables, so a force-quit at any instant loses at most one HTTP
 * response - never evidence - and every call is idempotent, so a lost
 * response is recovered by simply re-sending.
 */
export const SyncState = {
  /** Capture in progress; not yet submitted by the driver. */
  Draft: 'draft',
  /** Driver completed the attempt. Durable, waiting for the worker. */
  Queued: 'queued',
  /** Attempt JSON is in flight. */
  Submitting: 'submitting',
  /** Server has the attempt record; media (if any) still owed. */
  AttemptAcked: 'attempt_acked',
  /** Photos/signature uploading to S3. */
  UploadingMedia: 'uploading_media',
  /** Server confirmed the attempt AND verified every declared object. */
  Synced: 'synced',
  /** Parked: needs the driver. Never a graveyard, never auto-deleted. */
  NeedsAttention: 'needs_attention',
} as const;

export type SyncState = (typeof SyncState)[keyof typeof SyncState];

export const PhotoUploadState = {
  Pending: 'pending',
  Uploading: 'uploading',
  Uploaded: 'uploaded',
  Confirmed: 'confirmed',
} as const;

export type PhotoUploadState = (typeof PhotoUploadState)[keyof typeof PhotoUploadState];

export const FailureKind = {
  /** Retryable failures exhausted their budget. */
  Stuck: 'stuck',
  /** Server said no in a way that retrying cannot fix. */
  Rejected: 'rejected',
  /** A local file backing this evidence is gone. */
  EvidenceMissing: 'evidence_missing',
} as const;

export type FailureKind = (typeof FailureKind)[keyof typeof FailureKind];

const LEGAL_TRANSITIONS: Record<SyncState, SyncState[]> = {
  [SyncState.Draft]: [SyncState.Queued],
  [SyncState.Queued]: [SyncState.Submitting],
  [SyncState.Submitting]: [
    SyncState.AttemptAcked,
    SyncState.Queued, // retryable failure, backoff scheduled
    SyncState.NeedsAttention,
  ],
  [SyncState.AttemptAcked]: [
    SyncState.UploadingMedia,
    SyncState.Synced, // no media owed
    SyncState.NeedsAttention,
  ],
  [SyncState.UploadingMedia]: [
    SyncState.Synced,
    SyncState.AttemptAcked, // retryable media failure, backoff scheduled
    SyncState.NeedsAttention,
  ],
  // Terminal. Evidence that reached the server is never re-queued.
  [SyncState.Synced]: [],
  // Manual retry resumes at whichever phase the attempt actually reached.
  [SyncState.NeedsAttention]: [SyncState.Queued, SyncState.AttemptAcked],
};

export function canTransition(from: SyncState, to: SyncState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SyncState, to: SyncState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal sync transition: ${from} -> ${to}`);
  }
}

/** States the worker may pick up. */
export const WORKABLE_STATES: SyncState[] = [
  SyncState.Queued,
  SyncState.AttemptAcked,
  SyncState.UploadingMedia,
];

export const MAX_AUTO_RETRIES = 8;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 300_000;

/**
 * Full jitter (AWS style). Without the jitter, a van full of queued
 * attempts stampedes the load balancer the instant signal returns.
 */
export function backoffDelayMs(retryCount: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retryCount);
  return Math.floor(random() * ceiling);
}

export const FailureClass = {
  /** Worth retrying automatically. */
  Retryable: 'retryable',
  /** Retrying forever would be the definition of a poison message. */
  Permanent: 'permanent',
  /** Auth expired: refresh and replay. Not a failure, burns no retry. */
  AuthRefresh: 'auth_refresh',
  /** Presigned URL expired: re-request URLs, then retry. Burns no retry. */
  RefreshUrls: 'refresh_urls',
  /** Photo too large: recompress once, then treat as permanent. */
  Recompress: 'recompress',
  /** We were offline; nothing was actually attempted. Burns no retry. */
  Offline: 'offline',
} as const;

export type FailureClass = (typeof FailureClass)[keyof typeof FailureClass];

export interface FailureSignal {
  httpStatus?: number;
  networkError?: boolean;
  timedOut?: boolean;
  online: boolean;
}

/** One classifier used by every call site, so retry policy cannot drift. */
export function classifyFailure(signal: FailureSignal): FailureClass {
  if (!signal.online) return FailureClass.Offline;
  if (signal.timedOut || signal.networkError) return FailureClass.Retryable;

  const status = signal.httpStatus ?? 0;
  if (status === 401) return FailureClass.AuthRefresh;
  if (status === 403) return FailureClass.RefreshUrls; // S3 answers an expired presign with 403
  if (status === 409) return FailureClass.Retryable; // refresh already in flight
  if (status === 413) return FailureClass.Recompress;
  if (status === 408 || status === 429) return FailureClass.Retryable;
  if (status >= 500) return FailureClass.Retryable;
  if (status >= 400) return FailureClass.Permanent;
  return FailureClass.Retryable;
}
