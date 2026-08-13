import { SyncState } from './state-machine';

/**
 * "On server" means the server confirmed the attempt AND verified every
 * declared object in S3. Not "queued locally", not "the POST returned", not
 * "the S3 PUT returned". The driver has to be able to trust this label in a
 * dispute, so it is never allowed to run ahead of the server's ledger.
 */
export interface Badge {
  label: string;
  tone: 'neutral' | 'progress' | 'good' | 'alert';
}

/**
 * Seconds until a scheduled retry, or null if none is pending.
 *
 * Rounded up so a due retry never reads as "in 0s", and clamped so a clock
 * that jumped backwards cannot produce a countdown that never ends.
 */
export function secondsUntilRetry(
  nextRetryAt: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!nextRetryAt) return null;
  const due = Date.parse(nextRetryAt);
  if (Number.isNaN(due)) return null;
  const seconds = Math.ceil((due - now) / 1000);
  return seconds > 0 ? Math.min(seconds, 3600) : null;
}

export function attemptBadge(
  state: SyncState,
  media: { confirmed: number; total: number },
  online: boolean,
  retryInSeconds: number | null = null,
): Badge {
  switch (state) {
    case SyncState.Draft:
      return { label: 'Draft', tone: 'neutral' };
    case SyncState.Queued:
      if (retryInSeconds !== null) {
        return { label: `Retrying in ${retryInSeconds}s`, tone: 'progress' };
      }
      return online
        ? { label: 'Waiting to send', tone: 'progress' }
        : { label: 'On device', tone: 'neutral' };
    case SyncState.Submitting:
      return { label: 'Sending', tone: 'progress' };
    case SyncState.AttemptAcked:
    case SyncState.UploadingMedia:
      // Three states, told apart honestly. "Uploading" while work is actually
      // in flight, a countdown when the only thing happening is a wait, and
      // "needs attention" when nothing further will happen on its own. An
      // attempt parked behind a backoff used to read as uploading, which is
      // how one that had stopped making progress still looked busy.
      if (retryInSeconds !== null) {
        return { label: `Retrying in ${retryInSeconds}s`, tone: 'progress' };
      }
      return media.total > 0
        ? { label: `Evidence uploading ${media.confirmed}/${media.total}`, tone: 'progress' }
        : { label: 'Finishing', tone: 'progress' };
    case SyncState.Synced:
      return { label: 'On server', tone: 'good' };
    case SyncState.NeedsAttention:
      return { label: 'Needs attention', tone: 'alert' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

const SEVERITY: Record<SyncState, number> = {
  [SyncState.NeedsAttention]: 5,
  [SyncState.Submitting]: 4,
  [SyncState.UploadingMedia]: 4,
  [SyncState.AttemptAcked]: 4,
  [SyncState.Queued]: 3,
  [SyncState.Draft]: 2,
  [SyncState.Synced]: 1,
};

/** A stop shows its worst attempt, so a problem can never hide behind a success. */
export function worstState(states: SyncState[]): SyncState | null {
  if (states.length === 0) return null;
  return states.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), states[0]);
}

export interface BannerState {
  label: string;
  tone: Badge['tone'];
  visible: boolean;
}

export function syncBanner(
  counts: { onDevice: number; sending: number; uploading: number; needsAttention: number },
  online: boolean,
  needsReauth: boolean,
): BannerState {
  if (counts.needsAttention > 0) {
    return {
      label: `${counts.needsAttention} attempt${counts.needsAttention > 1 ? 's need' : ' needs'} attention`,
      tone: 'alert',
      visible: true,
    };
  }
  if (needsReauth) {
    return { label: 'Sign in to resume syncing', tone: 'alert', visible: true };
  }

  const pending = counts.onDevice + counts.sending + counts.uploading;
  if (!online) {
    return {
      label:
        pending > 0
          ? `Offline - ${pending} attempt${pending > 1 ? 's' : ''} safe on this device`
          : 'Offline',
      tone: 'neutral',
      visible: true,
    };
  }
  if (pending > 0) {
    return { label: `Syncing ${pending} attempt${pending > 1 ? 's' : ''}`, tone: 'progress', visible: true };
  }
  return { label: 'All evidence on server', tone: 'good', visible: false };
}
