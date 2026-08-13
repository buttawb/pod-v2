/**
 * A shared handset must never upload one driver's evidence under another
 * driver's credentials.
 *
 * The sync worker attaches whatever token the CURRENT session holds, and the
 * server takes driver_id from that token rather than from the payload. So if
 * the queue offers up any queued row on the device, driver A's delivery is
 * either recorded against driver B or refused with a 403 and parked. Both
 * outcomes lose evidence for the person who actually stood at the door.
 *
 * The predicate in claimNextWorkable is the only thing preventing that, which
 * is why it is pinned here rather than left to a comment. The previous guard -
 * a `quarantined_driver_id` marker - was written on sign-in and read nowhere,
 * so it looked like protection while providing none.
 */
jest.mock('./schema', () => ({
  getDatabase: jest.fn(),
  setMeta: jest.fn().mockResolvedValue(undefined),
}));

// attempts-repo pulls in expo-crypto for client-minted UUIDs; it is a native
// module and irrelevant to this query, so it is stubbed rather than loaded.
jest.mock('expo-crypto', () => ({ randomUUID: () => 'stub-uuid' }));

import { getDatabase } from './schema';
import { claimNextWorkable } from './attempts-repo';

const db = getDatabase as jest.Mock;

/** Captures the SQL and params the repo actually sends to SQLite. */
function captureQuery() {
  const getFirstAsync = jest.fn().mockResolvedValue(null);
  db.mockReturnValue({ getFirstAsync });
  return getFirstAsync;
}

describe('the sync queue only ever offers the signed-in driver work', () => {
  beforeEach(() => jest.clearAllMocks());

  it('scopes the claim to the driver recorded in sync_meta', async () => {
    const getFirstAsync = captureQuery();

    await claimNextWorkable();

    const [sql] = getFirstAsync.mock.calls[0];
    // Read from sync_meta rather than taken as an argument, so no caller can
    // forget to pass it and silently widen the queue.
    expect(sql).toContain("driver_id = (SELECT value FROM sync_meta WHERE key = 'driver_id')");
  });

  it('still filters on workable states and the retry clock', async () => {
    // The driver scope must be an addition, not a replacement: a regression
    // that dropped these would drain the queue regardless of backoff.
    const getFirstAsync = captureQuery();

    await claimNextWorkable();

    const [sql] = getFirstAsync.mock.calls[0];
    expect(sql).toContain("sync_state IN ('queued', 'attempt_acked', 'uploading_media')");
    expect(sql).toContain('next_retry_at IS NULL OR next_retry_at <= ?');
    expect(sql).toContain('ORDER BY finalized_at ASC');
  });

  it('keeps the skip list working alongside the driver scope', async () => {
    // One attempt that cannot progress must not block the ones behind it, and
    // adding the driver predicate must not have broken that.
    const getFirstAsync = captureQuery();

    await claimNextWorkable(new Set(['attempt-a', 'attempt-b']));

    const [sql, , ...params] = getFirstAsync.mock.calls[0];
    expect(sql).toContain('client_attempt_id NOT IN (?,?)');
    expect(params).toEqual(['attempt-a', 'attempt-b']);
  });

  it('asks for one row at a time', async () => {
    const getFirstAsync = captureQuery();

    await claimNextWorkable();

    expect(getFirstAsync.mock.calls[0][0]).toContain('LIMIT 1');
  });
});
