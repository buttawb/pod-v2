import { attemptBadge, secondsUntilRetry, syncBanner, worstState } from './badges';
import { SyncState } from './state-machine';

/**
 * The honesty rules. A badge that overstates what the server holds would
 * mislead a driver in a dispute, so "On server" is pinned to `synced` and
 * nothing else.
 */
describe('attempt badges', () => {
  const noMedia = { confirmed: 0, total: 0 };

  it('only says "On server" once the server has confirmed everything', () => {
    expect(attemptBadge(SyncState.Synced, noMedia, true).label).toBe('On server');

    for (const state of [
      SyncState.Draft,
      SyncState.Queued,
      SyncState.Submitting,
      SyncState.AttemptAcked,
      SyncState.UploadingMedia,
      SyncState.NeedsAttention,
    ]) {
      expect(attemptBadge(state, noMedia, true).label).not.toBe('On server');
    }
  });

  it('distinguishes "safe on device" from "waiting to send" by connectivity', () => {
    expect(attemptBadge(SyncState.Queued, noMedia, false).label).toBe('On device');
    expect(attemptBadge(SyncState.Queued, noMedia, true).label).toBe('Waiting to send');
  });

  it('shows real media progress rather than a spinner', () => {
    expect(attemptBadge(SyncState.UploadingMedia, { confirmed: 2, total: 4 }, true).label).toBe(
      'Evidence uploading 2/4',
    );
  });

  it('flags needs-attention loudly', () => {
    expect(attemptBadge(SyncState.NeedsAttention, noMedia, true).tone).toBe('alert');
  });
});

describe('stop rollup', () => {
  it('shows the worst attempt so a problem cannot hide behind a success', () => {
    expect(worstState([SyncState.Synced, SyncState.NeedsAttention])).toBe(SyncState.NeedsAttention);
    expect(worstState([SyncState.Synced, SyncState.Queued])).toBe(SyncState.Queued);
    expect(worstState([SyncState.Synced, SyncState.Synced])).toBe(SyncState.Synced);
    expect(worstState([])).toBeNull();
  });
});

describe('global banner', () => {
  const clear = { onDevice: 0, sending: 0, uploading: 0, needsAttention: 0 };

  it('hides itself only when everything really is on the server', () => {
    expect(syncBanner(clear, true, false).visible).toBe(false);
  });

  it('cannot be hidden while an attempt needs attention', () => {
    const banner = syncBanner({ ...clear, needsAttention: 1 }, true, false);
    expect(banner.visible).toBe(true);
    expect(banner.tone).toBe('alert');
  });

  it('reassures rather than alarms when offline with queued work', () => {
    const banner = syncBanner({ ...clear, onDevice: 4 }, false, false);
    expect(banner.label).toContain('safe on this device');
    expect(banner.tone).toBe('neutral');
  });

  it('asks for sign-in without implying evidence was lost', () => {
    expect(syncBanner(clear, true, true).label).toBe('Sign in to resume syncing');
  });
});

/**
 * Three states, told apart honestly.
 *
 * An attempt parked behind a backoff used to render as "Evidence uploading",
 * which is how one that had stopped making progress still looked busy. The
 * driver could not tell work in flight from a wait from a dead end.
 */
describe('uploading, retrying and parked are distinguishable', () => {
  const NOW = Date.parse('2026-08-12T10:00:00.000Z');

  it('reads as uploading only while something is actually in flight', () => {
    expect(
      attemptBadge(SyncState.UploadingMedia, { confirmed: 1, total: 2 }, true, null).label,
    ).toBe('Evidence uploading 1/2');
  });

  it('counts down instead of claiming to be uploading while it waits', () => {
    const badge = attemptBadge(
      SyncState.UploadingMedia,
      { confirmed: 1, total: 2 },
      true,
      secondsUntilRetry('2026-08-12T10:00:05.000Z', NOW),
    );
    expect(badge.label).toBe('Retrying in 5s');
  });

  it('says needs attention when nothing further will happen on its own', () => {
    expect(attemptBadge(SyncState.NeedsAttention, { confirmed: 0, total: 2 }, true, null)).toEqual({
      label: 'Needs attention',
      tone: 'alert',
    });
  });

  it('treats a due or absent retry as not waiting', () => {
    expect(secondsUntilRetry(null, NOW)).toBeNull();
    expect(secondsUntilRetry('2026-08-12T09:59:59.000Z', NOW)).toBeNull();
    expect(secondsUntilRetry('not a date', NOW)).toBeNull();
  });

  it('rounds up, so a retry that is nearly due never reads as 0s', () => {
    expect(secondsUntilRetry('2026-08-12T10:00:00.400Z', NOW)).toBe(1);
  });

  it('clamps a backwards clock jump instead of counting down for a year', () => {
    expect(secondsUntilRetry('2027-08-12T10:00:00.000Z', NOW)).toBe(3600);
  });
});
