import { SyncState } from '../sync/state-machine';
import {
  StopFilter,
  STOP_FILTER_ORDER,
  countByStopFilter,
  matchesStopFilter,
  matchesStopSearch,
  type FilterableStop,
} from './stop-filters';

function stop(overrides: Partial<FilterableStop> = {}): FilterableStop {
  return { attempt_count: 0, worst_sync_state: null, has_unfinished_draft: 0, ...overrides };
}

/**
 * A filter that lies costs more than no filter at all.
 *
 * The driver uses these to decide a stop is finished with. If "on server"
 * includes something still uploading, or "no attempts" includes a stop they
 * are part-way through, they will drive away from work that is not done.
 */
describe('stop filters', () => {
  it('shows everything under All', () => {
    expect(matchesStopFilter(stop(), StopFilter.All)).toBe(true);
    expect(
      matchesStopFilter(stop({ attempt_count: 3, worst_sync_state: SyncState.Synced }), StopFilter.All),
    ).toBe(true);
  });

  it('counts a part-finished capture as started, not as untouched', () => {
    // Listing a stop the driver is standing at under "no attempts" would send
    // them back to a door they never left.
    expect(matchesStopFilter(stop({ has_unfinished_draft: 1 }), StopFilter.NotStarted)).toBe(false);
    expect(matchesStopFilter(stop({ has_unfinished_draft: 1 }), StopFilter.Unfinished)).toBe(true);
    expect(matchesStopFilter(stop(), StopFilter.NotStarted)).toBe(true);
  });

  it('does not call anything still moving "on server"', () => {
    for (const state of [
      SyncState.Queued,
      SyncState.Submitting,
      SyncState.AttemptAcked,
      SyncState.UploadingMedia,
    ]) {
      const row = stop({ attempt_count: 1, worst_sync_state: state });
      expect(matchesStopFilter(row, StopFilter.OnDevice)).toBe(true);
      expect(matchesStopFilter(row, StopFilter.OnServer)).toBe(false);
    }
  });

  it('reserves "on server" for the state the server actually confirmed', () => {
    const row = stop({ attempt_count: 1, worst_sync_state: SyncState.Synced });
    expect(matchesStopFilter(row, StopFilter.OnServer)).toBe(true);
    expect(matchesStopFilter(row, StopFilter.OnDevice)).toBe(false);
  });

  it('surfaces a parked attempt on its own', () => {
    const row = stop({ attempt_count: 1, worst_sync_state: SyncState.NeedsAttention });
    expect(matchesStopFilter(row, StopFilter.NeedsAttention)).toBe(true);
    // Needs attention is not in flight: nothing further happens on its own,
    // so counting it as "on device" would bury it among rows that are fine.
    expect(matchesStopFilter(row, StopFilter.OnDevice)).toBe(false);
  });

  it('counts every filter over the same list', () => {
    const stops = [
      stop(),
      stop(),
      stop({ has_unfinished_draft: 1 }),
      stop({ attempt_count: 1, worst_sync_state: SyncState.Queued }),
      stop({ attempt_count: 1, worst_sync_state: SyncState.Synced }),
      stop({ attempt_count: 1, worst_sync_state: SyncState.NeedsAttention }),
    ];

    const counts = countByStopFilter(stops);

    expect(counts[StopFilter.All]).toBe(6);
    expect(counts[StopFilter.NotStarted]).toBe(2);
    expect(counts[StopFilter.Unfinished]).toBe(1);
    expect(counts[StopFilter.OnDevice]).toBe(1);
    expect(counts[StopFilter.OnServer]).toBe(1);
    expect(counts[StopFilter.NeedsAttention]).toBe(1);
  });

  it('gives every filter in the order a label', () => {
    // A chip with no label ships as a blank button, which is worse than a
    // missing filter because it looks like a bug the driver caused.
    for (const filter of STOP_FILTER_ORDER) {
      expect(matchesStopFilter(stop(), filter)).toBeDefined();
    }
    expect(STOP_FILTER_ORDER[0]).toBe(StopFilter.All);
  });
});

describe('stop search', () => {
  const target = { address: '27 Mill Lane', postcode: 'RM6 5DH' };

  it('shows the whole round when nothing is typed', () => {
    // A search box that empties the list until something is typed is worse
    // than no search box.
    expect(matchesStopSearch(target, '')).toBe(true);
    expect(matchesStopSearch(target, '   ')).toBe(true);
  });

  it('finds a stop by house number or street', () => {
    expect(matchesStopSearch(target, 'mill')).toBe(true);
    expect(matchesStopSearch(target, '27')).toBe(true);
    expect(matchesStopSearch(target, 'MILL LANE')).toBe(true);
  });

  it('finds a postcode however it was typed', () => {
    // Written "RM6 5DH" on the label, typed one-handed in a van.
    expect(matchesStopSearch(target, 'rm6 5dh')).toBe(true);
    expect(matchesStopSearch(target, 'rm65dh')).toBe(true);
    expect(matchesStopSearch(target, 'RM6')).toBe(true);
  });

  it('narrows on every term rather than widening', () => {
    expect(matchesStopSearch(target, 'mill 5dh')).toBe(true);
    expect(matchesStopSearch(target, 'mill e14')).toBe(false);
  });

  it('does not match a stop that has nothing to do with the query', () => {
    expect(matchesStopSearch(target, 'station')).toBe(false);
  });
});
