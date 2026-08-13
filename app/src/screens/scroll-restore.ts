/**
 * Getting a driver back to where they were in a 150 stop round.
 *
 * This is pure because reasoning about it was not enough: it was shipped wrong
 * twice. First as a single scrollToOffset on mount, which is correct-looking
 * code that does nothing, because FlatList is virtualised and at mount only a
 * handful of rows exist, so a request for offset 8000 is clamped to the bottom
 * of what has rendered, which is the top. Then as a climb that overwrote its
 * own target, because every programmatic scroll fires onScroll and onScroll
 * was writing the current position back into the remembered offset.
 *
 * So the decision lives here, where a test can drive the whole growth loop and
 * assert where it lands, instead of a comment claiming it works.
 */
export const MAX_RESTORE_STEPS = 24;

export type RestoreAction =
  /** Nothing to do: no saved position, or already back. */
  | { kind: 'done' }
  /** The target is reachable now. Scroll there and stop. */
  | { kind: 'settle'; offset: number }
  /**
   * The target is past the end of what is rendered. Scroll to the end of what
   * exists, which renders more rows, which grows the content, which asks again.
   */
  | { kind: 'climb'; offset: number };

export interface RestoreState {
  /** Where the driver was, captured once and never updated mid-climb. */
  target: number;
  /** Height of the content that currently exists, from onContentSizeChange. */
  contentHeight: number;
  /** How many climbs have already happened. */
  attempts: number;
}

/**
 * One step of the climb.
 *
 * Gives up after MAX_RESTORE_STEPS so a target that can never be reached,
 * which is what happens when the round comes back shorter than it was, cannot
 * scroll forever.
 */
export function planScrollRestore({
  target,
  contentHeight,
  attempts,
}: RestoreState): RestoreAction {
  if (target <= 0) return { kind: 'done' };
  if (attempts >= MAX_RESTORE_STEPS) return { kind: 'done' };

  // Strictly greater: the target has to be inside the rendered content, not at
  // its very edge, or the scroll lands short and the climb stalls one row out.
  if (contentHeight > target) return { kind: 'settle', offset: target };

  return { kind: 'climb', offset: contentHeight };
}
