/**
 * What stops the sync worker from doing the same work twice.
 *
 * Every trigger in the app is fire-and-forget: finalize kicks it, pull-to-sync
 * kicks it, boot kicks it, and NetInfo, AppState and a 60 second heartbeat all
 * kick it too. Two of those landing together is ordinary, not exotic, so the
 * reentrancy guard is load-bearing rather than defensive. When it leaks, the
 * submit phase absorbs the second run (the conditioned UPDATE makes the loser
 * a no-op) but the media phase does not: it re-presigns and re-PUTs evidence
 * the driver already paid for over a mobile connection.
 *
 * The attempts-repo fake below implements the real compare-and-set semantics
 * rather than returning canned values, so a failure here is a real failure.
 */
import { SyncState, PhotoUploadState, canTransition } from './state-machine';
import type { AttemptRow, PhotoRow } from '../db/attempts-repo';

jest.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));

jest.mock('../capture/media', () => ({ fileExists: () => true }));

jest.mock('../auth/session', () => ({
  SessionState: { Ok: 'ok', NeedsReauth: 'needs_reauth' },
  // A real SQLite read in production. The await is the whole point of this
  // file: it is the window a second kick() used to slip through.
  getSessionState: () => Promise.resolve('ok'),
}));

jest.mock('../api/client', () => {
  // Hand-rolled so `instanceof` still decides the failure class, and matching
  // the real constructor shape so a signature change breaks this file loudly.
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string | null,
      message: string,
      readonly body?: unknown,
    ) {
      super(message);
    }
  }
  class NetworkError extends Error {
    constructor(
      readonly timedOut: boolean,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    NetworkError,
    APP_VERSION: '1.0.0-test',
    apiRequest: jest.fn(),
    uploadToS3: jest.fn(),
  };
});

jest.mock('../db/attempts-repo', () => ({
  claimNextWorkable: jest.fn(),
  getAttempt: jest.fn(),
  getPhotos: jest.fn(),
  markNeedsAttention: jest.fn(),
  releaseForRetry: jest.fn(),
  scheduleRetry: jest.fn(),
  setPhotoState: jest.fn(),
  transitionTo: jest.fn(),
}));

import { apiRequest, uploadToS3, ApiError } from '../api/client';
import * as repo from '../db/attempts-repo';
import { syncEngine } from './sync-engine';

const api = apiRequest as jest.Mock;
const upload = uploadToS3 as jest.Mock;

/** Rows and photos, keyed by client_attempt_id, standing in for SQLite. */
let rows: Map<string, AttemptRow>;
let photosByAttempt: Map<string, PhotoRow[]>;
/**
 * The `skip` set the engine passed on each claim, snapshotted at call time.
 * The engine mutates the same Set after the call returns, so holding the
 * reference would make every assertion about it vacuously true.
 */
let claimSkips: Set<string>[];

function attempt(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    client_attempt_id: 'a1',
    stop_id: 'stop-1',
    attempt_no: 1,
    outcome: 'delivered_to_person',
    reason_code: null,
    neighbour_house_number: null,
    note: null,
    parcel_barcode: null,
    barcode_source: null,
    barcode_match: null,
    barcode_override_reason: null,
    retry_today: 0,
    signature_path: null,
    lat: 51.5,
    lng: -0.12,
    gps_accuracy_m: 8,
    captured_at: '2026-08-12T09:00:00.000Z',
    captured_at_monotonic: 1000,
    driver_id: 'driver-1',
    device_id: 'device-1',
    app_version: '1.0.0',
    sync_state: SyncState.Queued,
    retry_count: 0,
    next_retry_at: null,
    failure_kind: null,
    last_error_code: null,
    last_error_message: null,
    server_attempt_id: null,
    finalized_at: '2026-08-12T09:01:00.000Z',
    synced_at: null,
    ...overrides,
  };
}

function photo(overrides: Partial<PhotoRow> = {}): PhotoRow {
  return {
    client_attempt_id: 'a1',
    photo_index: 0,
    kind: 'photo',
    local_path: 'file:///evidence/a1-0.jpg',
    byte_size: 402_000,
    upload_state: PhotoUploadState.Pending,
    retry_count: 0,
    confirmed_at: null,
    ...overrides,
  };
}

/** A promise plus the handle to release it, to pin an interleaving exactly. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = new Map();
  photosByAttempt = new Map();
  claimSkips = [];

  let claims = 0;
  (repo.claimNextWorkable as jest.Mock).mockImplementation(async (skip: Set<string>) => {
    claimSkips.push(new Set(skip));
    // A regression in the touched set must fail an assertion, not spin the
    // suite forever in an infinite claim loop.
    if ((claims += 1) > 20) throw new Error('claim loop did not terminate');
    const workable: SyncState[] = [
      SyncState.Queued,
      SyncState.AttemptAcked,
      SyncState.UploadingMedia,
    ];
    for (const row of rows.values()) {
      if (!skip.has(row.client_attempt_id) && workable.includes(row.sync_state)) return row;
    }
    return null;
  });

  (repo.getAttempt as jest.Mock).mockImplementation(
    async (id: string) => rows.get(id) ?? null,
  );

  (repo.getPhotos as jest.Mock).mockImplementation(
    async (id: string) => photosByAttempt.get(id) ?? [],
  );

  // The real thing: read the row, refuse an illegal move, and refuse if the
  // state changed underneath. This is what makes the submit phase safe.
  (repo.transitionTo as jest.Mock).mockImplementation(
    async (id: string, to: SyncState, extra: Record<string, unknown> = {}) => {
      const row = rows.get(id);
      if (!row) return false;
      if (!canTransition(row.sync_state, to)) return false;
      rows.set(id, { ...row, ...extra, sync_state: to } as AttemptRow);
      return true;
    },
  );

  (repo.setPhotoState as jest.Mock).mockImplementation(
    async (id: string, index: number, state: PhotoUploadState) => {
      const list = photosByAttempt.get(id) ?? [];
      photosByAttempt.set(
        id,
        list.map((p) => (p.photo_index === index ? { ...p, upload_state: state } : p)),
      );
    },
  );

  (repo.scheduleRetry as jest.Mock).mockResolvedValue(undefined);
  (repo.releaseForRetry as jest.Mock).mockResolvedValue(undefined);
  (repo.markNeedsAttention as jest.Mock).mockImplementation(async (id: string) => {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, sync_state: SyncState.NeedsAttention });
  });
});

describe('one worker at a time', () => {
  it('ignores a second flush while one is already in flight', async () => {
    rows.set('a1', attempt());
    const held = gate();
    api.mockImplementation(async () => {
      await held.promise;
      return { attemptId: 'srv-1', clientAttemptId: 'a1', evidenceStatus: 'complete', deduplicated: false, uploads: [] };
    });

    const first = syncEngine.kick();
    // Let the first run get as far as its held network call.
    await Promise.resolve();
    await Promise.resolve();

    await syncEngine.kick();
    const claimsDuringFlight = claimSkips.length;

    held.open();
    await first;

    // The second kick did no work of its own: it claimed nothing and sent
    // nothing while the first was mid-flight.
    expect(claimsDuringFlight).toBe(1);
    expect(api.mock.calls.filter((c) => c[0] === '/api/v2/attempts')).toHaveLength(1);
  });

  it('sends the attempt POST once when two flushes race', async () => {
    rows.set('a1', attempt());
    api.mockImplementation(async (path: string) => {
      if (path === '/api/v2/attempts') {
        return {
          attemptId: 'srv-1',
          clientAttemptId: 'a1',
          evidenceStatus: 'complete',
          deduplicated: false,
          uploads: [],
        };
      }
      return { attemptComplete: true, evidenceStatus: 'complete' };
    });

    // Same tick, no awaits in between: the shape produced by finalize kicking
    // the engine while the heartbeat fires.
    await Promise.all([syncEngine.kick(), syncEngine.kick()]);

    expect(api.mock.calls.filter((c) => c[0] === '/api/v2/attempts')).toHaveLength(1);
    expect(rows.get('a1')?.sync_state).toBe(SyncState.Synced);
  });

  /**
   * The expensive half. Submit is protected by its conditioned UPDATE, but
   * uploadMedia discards what transitionTo returns, so a second run walks
   * straight past it and re-uploads bytes that are already on their way.
   */
  it('uploads each evidence file once when two flushes race', async () => {
    rows.set('a1', attempt({ sync_state: SyncState.AttemptAcked, server_attempt_id: 'srv-1' }));
    photosByAttempt.set('a1', [photo()]);

    const held = gate();
    api.mockImplementation(async (path: string) => {
      if (path.endsWith('/upload-urls')) {
        await held.promise;
        return [{ kind: 'photo', photoIndex: 0, s3Key: 'k', url: 'https://s3.test/put' }];
      }
      return { attemptComplete: true, evidenceStatus: 'complete' };
    });
    upload.mockResolvedValue(undefined);

    const both = Promise.all([syncEngine.kick(), syncEngine.kick()]);
    await Promise.resolve();
    await Promise.resolve();
    held.open();
    await both;

    expect(upload).toHaveBeenCalledTimes(1);
  });
});

/**
 * The stuck-evidence incident, as a test.
 *
 * A photo reached S3 and the server would not verify it, so finalize kept
 * answering "not complete". The handset showed "finishing evidence upload"
 * indefinitely, and the one thing that made it look survivable was that the
 * client had already marked a photo confirmed on its own authority. It had
 * not been acknowledged by anything.
 *
 * Two properties are pinned here: the client never claims evidence is on the
 * server until the server says so, and the attempt reaches synced under its
 * own recheck, with no app lifecycle event to rescue it. The test fires no
 * AppState or NetInfo events at all, so reaching synced can only have come
 * from the engine's own scheduling.
 */
describe('evidence is never confirmed ahead of the server', () => {
  it('rechecks on its own and reaches synced with no lifecycle event', async () => {
    rows.set('a1', attempt({ sync_state: SyncState.AttemptAcked, server_attempt_id: 'srv-1' }));
    photosByAttempt.set('a1', [
      photo({ photo_index: 0 }),
      photo({
        photo_index: 100,
        kind: 'signature',
        local_path: 'file:///evidence/a1-sig.png',
      }),
    ]);

    // The server has the bytes but has not verified them yet: exactly what a
    // finalize issued moments after the PUT returned 200 sees.
    let serverVerified = false;
    const retries: Array<{ code: string; firstDelayMs?: number }> = [];
    (repo.scheduleRetry as jest.Mock).mockImplementation(
      async (id: string, code: string, _msg: string, opts: { firstDelayMs?: number } = {}) => {
        retries.push({ code, firstDelayMs: opts.firstDelayMs });
        const row = rows.get(id);
        // Park it exactly as the real repo would, so the next kick has to
        // clear the gate rather than sail through.
        if (row) rows.set(id, { ...row, next_retry_at: 'later', retry_count: row.retry_count + 1 });
      },
    );
    (repo.claimNextWorkable as jest.Mock).mockImplementation(async (skip: Set<string>) => {
      claimSkips.push(new Set(skip));
      for (const row of rows.values()) {
        if (skip.has(row.client_attempt_id)) continue;
        if (row.next_retry_at) continue;
        if (
          ([SyncState.Queued, SyncState.AttemptAcked, SyncState.UploadingMedia] as SyncState[])
            .includes(row.sync_state)
        ) {
          return row;
        }
      }
      return null;
    });

    api.mockImplementation(async (path: string) => {
      if (path.endsWith('/upload-urls')) {
        return [
          { kind: 'photo', photoIndex: 0, s3Key: 'k0', url: 'https://s3.test/0' },
          { kind: 'signature', s3Key: 'ksig', url: 'https://s3.test/sig' },
        ];
      }
      return {
        attemptComplete: serverVerified,
        evidenceStatus: serverVerified ? 'complete' : 'pending_media',
      };
    });
    upload.mockResolvedValue(undefined);

    await syncEngine.kick();

    // Both PUTs returned 200 and the server still says no. Nothing may be
    // called confirmed on the strength of a 200 from S3.
    expect(upload).toHaveBeenCalledTimes(2);
    const confirmedEarly = (photosByAttempt.get('a1') ?? []).filter(
      (p) => p.upload_state === PhotoUploadState.Confirmed,
    );
    expect(confirmedEarly).toHaveLength(0);
    expect(rows.get('a1')?.sync_state).not.toBe(SyncState.Synced);

    // And it asks again quickly, rather than treating "too early" as a fault
    // and disappearing into exponential backoff.
    expect(retries).toEqual([{ code: 'MEDIA_INCOMPLETE', firstDelayMs: 5000 }]);

    // The recheck falls due and the server has caught up. No AppState change,
    // no NetInfo edge, no user action.
    serverVerified = true;
    const parked = rows.get('a1')!;
    rows.set('a1', { ...parked, next_retry_at: null });
    await syncEngine.kick();

    expect(rows.get('a1')?.sync_state).toBe(SyncState.Synced);
    expect(
      (photosByAttempt.get('a1') ?? []).every(
        (p) => p.upload_state === PhotoUploadState.Confirmed,
      ),
    ).toBe(true);
  });

  it('does not confirm an object the server returned no target for', async () => {
    rows.set('a1', attempt({ sync_state: SyncState.AttemptAcked, server_attempt_id: 'srv-1' }));
    photosByAttempt.set('a1', [photo({ photo_index: 0 })]);

    // The server asks for nothing. That used to be read as "it already holds
    // it" and the row was marked confirmed without a byte being sent.
    api.mockImplementation(async (path: string) => {
      if (path.endsWith('/upload-urls')) return [];
      return { attemptComplete: false, evidenceStatus: 'pending_media' };
    });

    await syncEngine.kick();

    expect(upload).not.toHaveBeenCalled();
    expect(photosByAttempt.get('a1')?.[0].upload_state).not.toBe(PhotoUploadState.Confirmed);
  });
});

describe('a stuck attempt never strands the queue behind it', () => {
  it('does not claim a row it already handled in this cycle', async () => {
    rows.set('a1', attempt());
    api.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'Server error'));

    await syncEngine.kick();

    // First claim sees an empty skip set; the second is told to leave a1
    // alone, even though a1 is still in a workable state after the retry.
    expect(claimSkips[0].size).toBe(0);
    expect([...claimSkips[1]]).toEqual(['a1']);
    expect(api.mock.calls.filter((c) => c[0] === '/api/v2/attempts')).toHaveLength(1);
  });

  it('keeps draining the queue past a row that cannot progress', async () => {
    rows.set('a1', attempt({ client_attempt_id: 'a1' }));
    rows.set('a2', attempt({ client_attempt_id: 'a2', stop_id: 'stop-2' }));

    api.mockImplementation(async (path: string, opts: { body?: { clientAttemptId?: string } }) => {
      if (path === '/api/v2/attempts') {
        if (opts.body?.clientAttemptId === 'a1') throw new ApiError(500, 'SERVER_ERROR', 'Server error');
        return {
          attemptId: 'srv-2',
          clientAttemptId: 'a2',
          evidenceStatus: 'complete',
          deduplicated: false,
          uploads: [],
        };
      }
      return { attemptComplete: true, evidenceStatus: 'complete' };
    });

    await syncEngine.kick();

    // The whole reason the touched set exists: one bad row must not cost the
    // driver a day of evidence sitting on the handset.
    expect(rows.get('a2')?.sync_state).toBe(SyncState.Synced);
  });
});

/**
 * The notification that makes a subscribed screen re-read.
 *
 * My Route reads the round once and then relies on this: if the engine stops
 * notifying, a delivered stop keeps its pending pin until the screen is closed
 * and reopened, and a driver reading that map goes back to a door they have
 * already been to.
 */
describe('screens are told when the round changes', () => {
  it('notifies subscribers after an attempt reaches the server', async () => {
    rows.set('a1', attempt());
    api.mockImplementation(async (path: string) => {
      if (path === '/api/v2/attempts') {
        return {
          attemptId: 'srv-1',
          clientAttemptId: 'a1',
          evidenceStatus: 'complete',
          deduplicated: false,
          uploads: [],
        };
      }
      return { attemptComplete: true, evidenceStatus: 'complete' };
    });

    const seen: SyncState[] = [];
    const unsubscribe = syncEngine.subscribe(() => {
      const row = rows.get('a1');
      if (row) seen.push(row.sync_state);
    });

    await syncEngine.kick();
    unsubscribe();

    // At least one notification, and the state visible to a subscriber at that
    // moment is the settled one: a screen re-reading here sees the delivery.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(SyncState.Synced);
  });

  it('stops notifying once a screen unsubscribes', async () => {
    rows.set('a1', attempt());
    api.mockResolvedValue({ attemptComplete: true, evidenceStatus: 'complete' });

    const listener = jest.fn();
    syncEngine.subscribe(listener)();

    syncEngine.announce();

    expect(listener).not.toHaveBeenCalled();
  });

  it('announce reaches subscribers, which is how a route pull refreshes a screen', () => {
    const listener = jest.fn();
    const unsubscribe = syncEngine.subscribe(listener);

    syncEngine.announce();
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
