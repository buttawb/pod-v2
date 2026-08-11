import {
  assertTransition,
  backoffDelayMs,
  canTransition,
  classifyFailure,
  FailureClass,
  MAX_AUTO_RETRIES,
  SyncState,
  WORKABLE_STATES,
} from './state-machine';

/**
 * The sync engine IS this table, so this is the highest-value test file in
 * the app: an illegal transition here is evidence in the wrong state on a
 * real driver's phone.
 */
describe('sync state machine', () => {
  const legal: Array<[SyncState, SyncState]> = [
    [SyncState.Draft, SyncState.Queued],
    [SyncState.Queued, SyncState.Submitting],
    [SyncState.Submitting, SyncState.AttemptAcked],
    [SyncState.Submitting, SyncState.Queued],
    [SyncState.Submitting, SyncState.NeedsAttention],
    [SyncState.AttemptAcked, SyncState.UploadingMedia],
    [SyncState.AttemptAcked, SyncState.Synced],
    [SyncState.UploadingMedia, SyncState.Synced],
    [SyncState.UploadingMedia, SyncState.AttemptAcked],
    [SyncState.NeedsAttention, SyncState.Queued],
    [SyncState.NeedsAttention, SyncState.AttemptAcked],
  ];

  it.each(legal)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const illegal: Array<[SyncState, SyncState]> = [
    // Evidence the server confirmed is never re-queued or re-sent.
    [SyncState.Synced, SyncState.Queued],
    [SyncState.Synced, SyncState.Submitting],
    [SyncState.Synced, SyncState.NeedsAttention],
    // A draft cannot skip the finalize boundary.
    [SyncState.Draft, SyncState.Submitting],
    [SyncState.Draft, SyncState.Synced],
    // Media cannot be declared complete before the attempt is acked.
    [SyncState.Queued, SyncState.Synced],
    [SyncState.Queued, SyncState.UploadingMedia],
    // Parked evidence never silently becomes "done".
    [SyncState.NeedsAttention, SyncState.Synced],
  ];

  it.each(illegal)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(/Illegal sync transition/);
  });

  it('treats synced as terminal', () => {
    for (const state of Object.values(SyncState)) {
      expect(canTransition(SyncState.Synced, state)).toBe(false);
    }
  });

  it('only exposes states the worker can act on', () => {
    expect(WORKABLE_STATES).toEqual([
      SyncState.Queued,
      SyncState.AttemptAcked,
      SyncState.UploadingMedia,
    ]);
    expect(WORKABLE_STATES).not.toContain(SyncState.NeedsAttention);
    expect(WORKABLE_STATES).not.toContain(SyncState.Draft);
  });
});

describe('backoff', () => {
  it('grows exponentially and stays under the 300s ceiling', () => {
    const alwaysMax = () => 0.999999;
    expect(backoffDelayMs(0, alwaysMax)).toBeLessThanOrEqual(2000);
    expect(backoffDelayMs(1, alwaysMax)).toBeLessThanOrEqual(4000);
    expect(backoffDelayMs(3, alwaysMax)).toBeLessThanOrEqual(16_000);
    for (let n = 0; n <= 20; n += 1) {
      expect(backoffDelayMs(n, alwaysMax)).toBeLessThanOrEqual(300_000);
    }
  });

  it('applies full jitter so a van full of queued attempts does not stampede', () => {
    // Same retry count, different random draws must produce different delays.
    expect(backoffDelayMs(5, () => 0)).toBe(0);
    expect(backoffDelayMs(5, () => 0.5)).toBeGreaterThan(0);
    expect(backoffDelayMs(5, () => 0.5)).toBeLessThan(backoffDelayMs(5, () => 0.99));
  });

  it('gives up after the retry budget', () => {
    expect(MAX_AUTO_RETRIES).toBe(8);
  });
});

describe('failure classification', () => {
  const online = { online: true };

  it.each<[string, Parameters<typeof classifyFailure>[0], FailureClass]>([
    ['timeout', { ...online, timedOut: true }, FailureClass.Retryable],
    ['network drop', { ...online, networkError: true }, FailureClass.Retryable],
    ['500', { ...online, httpStatus: 500 }, FailureClass.Retryable],
    ['503', { ...online, httpStatus: 503 }, FailureClass.Retryable],
    ['429', { ...online, httpStatus: 429 }, FailureClass.Retryable],
    ['409 refresh in flight', { ...online, httpStatus: 409 }, FailureClass.Retryable],
    ['401', { ...online, httpStatus: 401 }, FailureClass.AuthRefresh],
    ['403 expired presign', { ...online, httpStatus: 403 }, FailureClass.RefreshUrls],
    ['413', { ...online, httpStatus: 413 }, FailureClass.Recompress],
    ['422 validation', { ...online, httpStatus: 422 }, FailureClass.Permanent],
    ['400', { ...online, httpStatus: 400 }, FailureClass.Permanent],
    ['404', { ...online, httpStatus: 404 }, FailureClass.Permanent],
  ])('classifies %s', (_label, signal, expected) => {
    expect(classifyFailure(signal)).toBe(expected);
  });

  it('does not burn retries while offline: a basement is not a failure', () => {
    expect(classifyFailure({ online: false, networkError: true })).toBe(FailureClass.Offline);
    expect(classifyFailure({ online: false, timedOut: true })).toBe(FailureClass.Offline);
  });

  it('never classifies a validation error as retryable (poison-message guard)', () => {
    for (const status of [400, 404, 422]) {
      expect(classifyFailure({ ...online, httpStatus: status })).not.toBe(FailureClass.Retryable);
    }
  });
});
