import { MAX_RESTORE_STEPS, planScrollRestore } from './scroll-restore';

/**
 * Drives the whole restore the way FlatList does.
 *
 * Virtualisation is the thing that broke this twice, so the test models it: the
 * list only ever renders a bit beyond where you have scrolled, so content grows
 * in steps and each scroll unlocks the next one. `settle` is the only outcome
 * that means the driver is actually back where they were.
 */
function runClimb(options: {
  target: number;
  fullHeight: number;
  /** How much content exists beyond the current scroll position. */
  renderAhead?: number;
  initialHeight?: number;
}): { landedAt: number | null; steps: number } {
  const renderAhead = options.renderAhead ?? 1200;
  let contentHeight = options.initialHeight ?? 900;
  let attempts = 0;
  let landedAt: number | null = null;

  for (let i = 0; i < 200; i += 1) {
    const action = planScrollRestore({ target: options.target, contentHeight, attempts });

    if (action.kind === 'done') break;
    if (action.kind === 'settle') {
      landedAt = action.offset;
      break;
    }

    // Climbed to the end of what exists; the list renders further ahead.
    attempts += 1;
    contentHeight = Math.min(action.offset + renderAhead, options.fullHeight);
  }

  return { landedAt, steps: attempts };
}

describe('restoring the scroll position', () => {
  it('lands exactly where the driver was, deep in a long round', () => {
    // Stop ~96 of 151. This is the case that failed on the handset.
    const { landedAt } = runClimb({ target: 8400, fullHeight: 13000 });
    expect(landedAt).toBe(8400);
  });

  it('does not stop at the first content it sees', () => {
    // The original bug: content is 900px tall at mount, so a single scroll to
    // 8400 was clamped to 900 and the driver was back at the top.
    const first = planScrollRestore({ target: 8400, contentHeight: 900, attempts: 0 });
    expect(first).toEqual({ kind: 'climb', offset: 900 });
  });

  it('settles as soon as the target is inside rendered content', () => {
    expect(planScrollRestore({ target: 8400, contentHeight: 8401, attempts: 3 })).toEqual({
      kind: 'settle',
      offset: 8400,
    });
  });

  it('keeps climbing while the target is still past the end', () => {
    expect(planScrollRestore({ target: 8400, contentHeight: 8400, attempts: 3 })).toEqual({
      kind: 'climb',
      offset: 8400,
    });
  });

  it('reaches the bottom of the round', () => {
    const { landedAt } = runClimb({ target: 12800, fullHeight: 13000 });
    expect(landedAt).toBe(12800);
  });

  it('does nothing when there is no saved position', () => {
    expect(planScrollRestore({ target: 0, contentHeight: 900, attempts: 0 })).toEqual({
      kind: 'done',
    });
  });

  it('gives up rather than scrolling forever when the round came back shorter', () => {
    // Yesterday's offset against a round that is now half the length: the
    // target can never be reached, and the climb must end.
    const { landedAt, steps } = runClimb({ target: 20000, fullHeight: 6000 });

    expect(landedAt).toBeNull();
    expect(steps).toBeLessThanOrEqual(MAX_RESTORE_STEPS);
  });

  it('finishes well inside the step budget on a realistic round', () => {
    // If a 150 stop round needed anything close to the cap, the cap would be
    // silently truncating real restores.
    const { steps } = runClimb({ target: 8400, fullHeight: 13000 });
    expect(steps).toBeLessThan(MAX_RESTORE_STEPS / 2);
  });

  it('still lands when the list renders only a little ahead each time', () => {
    // A slower, more conservative FlatList: more steps, same destination.
    const { landedAt, steps } = runClimb({ target: 8400, fullHeight: 13000, renderAhead: 500 });
    expect(landedAt).toBe(8400);
    expect(steps).toBeLessThanOrEqual(MAX_RESTORE_STEPS);
  });
});
