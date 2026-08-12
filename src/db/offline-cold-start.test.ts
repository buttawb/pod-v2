/**
 * Cold start with the network dead.
 *
 * This is the requirement the whole architecture is arranged around: a driver
 * opens the app in a basement, at a loading bay, in a lift, and the full day
 * has to be there. The rule that makes it hold is that screens read SQLite and
 * the network only ever writes to it, so this test asserts the rule rather than
 * the screens: every fetch rejects, and the round still comes back.
 *
 * A cancelled stop is included on purpose. Pull-sync must tombstone rather than
 * delete, because a stop dispatch pulled after the driver worked it still has
 * evidence attached, and deleting the row would take the evidence with it.
 */
jest.mock('./schema', () => ({
  getDatabase: jest.fn(),
  setMeta: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../api/client', () => ({
  apiRequest: jest.fn(),
}));

jest.mock('../sync/sync-engine', () => ({
  syncEngine: { announce: jest.fn(), isOnline: () => false },
}));

import { apiRequest } from '../api/client';
import { getDatabase } from './schema';
import { getTodayStops, refreshTodayStops, todayKey } from './stops-repo';

const api = apiRequest as jest.Mock;
const db = getDatabase as jest.Mock;

/** The round as it already sits on the device from a previous connected day. */
const CACHED_ROUND = [
  { stop_id: 's1', seq: 1, address: '239 Station Road', postcode: 'SW9 4LJ', removed: 0 },
  { stop_id: 's2', seq: 2, address: '27 Mill Lane', postcode: 'RM6 5DH', removed: 0 },
  { stop_id: 's3', seq: 3, address: '14 Manor Road', postcode: 'SE22 9FX', removed: 1 },
];

describe('offline cold start', () => {
  let getAllAsync: jest.Mock;
  let database: {
    getAllAsync: jest.Mock;
    getFirstAsync: jest.Mock;
    runAsync: jest.Mock;
    withTransactionAsync: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getAllAsync = jest.fn().mockResolvedValue(CACHED_ROUND);
    database = {
      getAllAsync,
      getFirstAsync: jest.fn(),
      runAsync: jest.fn(),
      withTransactionAsync: jest.fn(),
    };
    db.mockReturnValue(database);
    // Every network call fails, exactly as it does with no signal.
    api.mockRejectedValue(new Error('Network request failed'));
  });

  it('renders the full day from SQLite with every request failing', async () => {
    const stops = await getTodayStops();

    expect(stops).toHaveLength(3);
    expect(stops.map((s) => s.address)).toEqual([
      '239 Station Road',
      '27 Mill Lane',
      '14 Manor Road',
    ]);
    // The read never touched the network. If a screen ever starts reading from
    // a response instead of the cache, this is what catches it.
    expect(api).not.toHaveBeenCalled();
  });

  it('reads the day out of the database, not from a response', async () => {
    await getTodayStops();

    const [sql, param] = getAllAsync.mock.calls[0];
    expect(sql).toContain('FROM stops s');
    expect(sql).toContain('WHERE s.route_date = ?');
    expect(param).toBe(todayKey());
  });

  it('keeps a cancelled stop in the round rather than dropping it', async () => {
    // Tombstoned, not deleted: it may carry evidence the driver already
    // captured, and the list is where that stays visible.
    const stops = await getTodayStops();
    expect(stops.find((s) => s.stop_id === 's3')?.removed).toBe(1);
  });

  it('surfaces the failure to the caller instead of emptying the cache', async () => {
    // refreshTodayStops rejecting is how the app learns there is no signal.
    // What matters is that it changes nothing: the callers catch it and the
    // round on disk is untouched, so a failed pull can never blank the day.
    await expect(refreshTodayStops()).rejects.toThrow('Network request failed');

    // Nothing was written. The pull fails at the request, before the database
    // is touched at all, so a failed refresh cannot half-apply a round.
    expect(database.runAsync).not.toHaveBeenCalled();
    expect(database.withTransactionAsync).not.toHaveBeenCalled();

    const stops = await getTodayStops();
    expect(stops).toHaveLength(3);
  });
});
