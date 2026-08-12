import { SyncState } from '../sync/state-machine';

/**
 * Filters for a day's stop list.
 *
 * A round is 150 stops and the list is ordered by sequence, which is the right
 * default because that is the order the van drives. It is the wrong order for
 * every other question a driver actually asks: what have I not done, what is
 * still sitting on this phone, what went wrong. Scrolling 150 rows to find
 * three is not an answer.
 *
 * Every one of these reads state the row already carries, so filtering is
 * local and works with no signal. Nothing here asks the server anything: the
 * device is the system of record for what has been captured, and a filter that
 * needed a network call would be useless in the basement where the driver most
 * needs it.
 */
export const StopFilter = {
  All: 'all',
  NotStarted: 'not_started',
  Unfinished: 'unfinished',
  OnDevice: 'on_device',
  OnServer: 'on_server',
  NeedsAttention: 'needs_attention',
} as const;

export type StopFilter = (typeof StopFilter)[keyof typeof StopFilter];

/** Order shown to the driver: the whole round, then narrowing questions. */
export const STOP_FILTER_ORDER: StopFilter[] = [
  StopFilter.All,
  StopFilter.NotStarted,
  StopFilter.Unfinished,
  StopFilter.OnDevice,
  StopFilter.OnServer,
  StopFilter.NeedsAttention,
];

export const STOP_FILTER_LABELS: Record<StopFilter, string> = {
  [StopFilter.All]: 'All',
  [StopFilter.NotStarted]: 'No attempts',
  [StopFilter.Unfinished]: 'Unfinished',
  [StopFilter.OnDevice]: 'On device',
  [StopFilter.OnServer]: 'On server',
  [StopFilter.NeedsAttention]: 'Needs attention',
};

/** The states where evidence exists but the server has not confirmed it yet. */
const IN_FLIGHT: SyncState[] = [
  SyncState.Queued,
  SyncState.Submitting,
  SyncState.AttemptAcked,
  SyncState.UploadingMedia,
];

/** The fields a filter reads. Kept narrow so any row shape can be tested. */
export interface FilterableStop {
  attempt_count: number;
  worst_sync_state: SyncState | null;
  has_unfinished_draft: number;
}

export function matchesStopFilter(stop: FilterableStop, filter: StopFilter): boolean {
  switch (filter) {
    case StopFilter.All:
      return true;

    case StopFilter.NotStarted:
      // A draft is not an attempt, but it is not nothing either: a stop the
      // driver is part-way through is not one they have yet to start, and
      // listing it under "no attempts" would send them back to a door they
      // are standing at.
      return stop.attempt_count === 0 && stop.has_unfinished_draft !== 1;

    case StopFilter.Unfinished:
      return stop.has_unfinished_draft === 1;

    case StopFilter.OnDevice:
      return stop.worst_sync_state !== null && IN_FLIGHT.includes(stop.worst_sync_state);

    case StopFilter.OnServer:
      // Only the terminal state counts. "Uploading" is not "on server", and
      // the whole point of that distinction is that a driver can trust the
      // label in a dispute.
      return stop.worst_sync_state === SyncState.Synced;

    case StopFilter.NeedsAttention:
      return stop.worst_sync_state === SyncState.NeedsAttention;

    default:
      return true;
  }
}

/**
 * How many stops each filter would show.
 *
 * Shown on the chips so the driver can see there is nothing to look at without
 * tapping through to an empty list, and so a filter holding one stranded
 * attempt is visible from the top of the screen.
 */
export function countByStopFilter(stops: FilterableStop[]): Record<StopFilter, number> {
  const counts = {} as Record<StopFilter, number>;
  for (const filter of STOP_FILTER_ORDER) {
    counts[filter] = stops.reduce((n, stop) => n + (matchesStopFilter(stop, filter) ? 1 : 0), 0);
  }
  return counts;
}
