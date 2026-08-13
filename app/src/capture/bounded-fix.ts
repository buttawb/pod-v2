import type { Fix } from './media';

/**
 * How long a submit will wait for a GPS fix before recording that there was
 * none.
 *
 * Long enough that a fix outdoors almost always arrives, short enough that a
 * driver in a stairwell is not left holding a phone. The number is a trade
 * against the thing that actually matters: the attempt reaching disk.
 */
export const FIX_BUDGET_MS = 5000;

/** Schedules the deadline and hands back the way to cancel it. */
export type Schedule = (fire: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

/**
 * A fix if one arrives in time, null if it does not.
 *
 * Submit used to await `getCurrentFix()` with no bound at all. Indoors,
 * `getCurrentPositionAsync` can sit indefinitely, and during that window the
 * driver watched a spinner while the attempt was still not durable: a
 * force-quit there lost the finalize entirely. That inverted the app's own
 * priority, where evidence is written first and enrichment follows. Here a
 * nice-to-have field was gating the one write that matters.
 *
 * So the wait is bounded and losing is a normal outcome, not an error. Null is
 * a first-class answer at every layer already: the device column, the sync
 * payload, the DTO and the Postgres column are all nullable, and the details
 * screen says "No GPS fix at capture" rather than inventing a coordinate.
 *
 * A fix that arrives after the budget is discarded. It is not written back and
 * not attached later: an attempt is append-only, and a position recorded
 * thirty seconds after the driver walked away is not where the delivery
 * happened.
 *
 * The deadline is always cancelled, win or lose, so a resolved race leaves no
 * timer pending behind it. `schedule` is injectable so this can be tested in
 * milliseconds rather than by making a suite sit through the real budget.
 */
export async function fixWithinBudget(
  getFix: () => Promise<Fix | null>,
  budgetMs: number = FIX_BUDGET_MS,
  schedule: Schedule = defaultSchedule,
): Promise<Fix | null> {
  let cancel: () => void = () => undefined;

  const expired = new Promise<null>((resolve) => {
    cancel = schedule(() => resolve(null), budgetMs);
  });

  try {
    // A throw from the location provider is the same outcome as running out of
    // time: no fix, and capture carries on regardless.
    return await Promise.race([getFix().catch(() => null), expired]);
  } finally {
    cancel();
  }
}
