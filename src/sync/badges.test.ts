import { attemptBadge, syncBanner, worstState } from './badges';
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
