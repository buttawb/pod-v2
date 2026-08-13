import { FIX_BUDGET_MS, fixWithinBudget, type Schedule } from './bounded-fix';
import type { Fix } from './media';

const FIX: Fix = { lat: 51.5074, lng: -0.1278, accuracyM: 8 };

/** A deadline the test fires by hand, so nothing waits on a real clock. */
function manualSchedule(): { schedule: Schedule; expire: () => void; cancelled: () => boolean } {
  let fire: (() => void) | null = null;
  let cancelled = false;
  return {
    schedule: (f) => {
      fire = f;
      return () => {
        cancelled = true;
      };
    },
    expire: () => fire?.(),
    cancelled: () => cancelled,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The bounded wait for a GPS fix at submit.
 *
 * Submit used to await the location provider with no bound. Indoors that call
 * can sit indefinitely, and for the whole of that window the attempt was not
 * yet on disk: a force-quit there lost the finalize outright. A nice-to-have
 * field was gating the one write that matters, which is backwards for an
 * evidence app.
 */
describe('fixWithinBudget', () => {
  it('gives up on time and lets the attempt finalize with no position', async () => {
    // The provider never answers, which is the stairwell case.
    const never = deferred<Fix | null>();
    const clock = manualSchedule();

    const race = fixWithinBudget(() => never.promise, 5000, clock.schedule);
    clock.expire();

    await expect(race).resolves.toBeNull();
  });

  it('discards a fix that arrives after the budget', async () => {
    // Append-only means append-only: a position recorded after the driver
    // walked away is not where the delivery happened, so it is not written
    // back and not attached later.
    const late = deferred<Fix | null>();
    const clock = manualSchedule();

    const race = fixWithinBudget(() => late.promise, 5000, clock.schedule);
    clock.expire();
    const result = await race;

    late.resolve(FIX);
    await Promise.resolve();

    expect(result).toBeNull();
    // The already-settled race cannot change its answer.
    await expect(race).resolves.toBeNull();
  });

  it('keeps a fix that arrives in time, accuracy and all', async () => {
    const clock = manualSchedule();

    await expect(fixWithinBudget(async () => FIX, 5000, clock.schedule)).resolves.toEqual({
      lat: 51.5074,
      lng: -0.1278,
      accuracyM: 8,
    });
  });

  it('cancels the deadline once the race settles, either way', async () => {
    // A timer left pending after every submit is a leak the driver pays for
    // across a 150 stop day.
    const won = manualSchedule();
    await fixWithinBudget(async () => FIX, 5000, won.schedule);
    expect(won.cancelled()).toBe(true);

    const lost = manualSchedule();
    const race = fixWithinBudget(() => deferred<Fix | null>().promise, 5000, lost.schedule);
    lost.expire();
    await race;
    expect(lost.cancelled()).toBe(true);
  });

  it('treats a provider error as no fix rather than a failed submit', async () => {
    // Permission revoked, hardware off, provider throwing: none of these are a
    // reason to refuse to record a delivery that happened.
    const clock = manualSchedule();

    await expect(
      fixWithinBudget(async () => {
        throw new Error('location unavailable');
      }, 5000, clock.schedule),
    ).resolves.toBeNull();
  });

  it('budgets five seconds by default', () => {
    // Long enough that a fix outdoors almost always lands, short enough that a
    // driver indoors is not left holding the phone.
    expect(FIX_BUDGET_MS).toBe(5000);
  });
});
