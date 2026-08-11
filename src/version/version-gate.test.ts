import { compareSemver, gateLevel, GateLevel } from './version-gate';

// The app build under test.
const APP_VERSION = '2.0.0';

const state = (over: Partial<Parameters<typeof gateLevel>[0]> = {}) => ({
  minAppVersion: null,
  latestAppVersion: null,
  killSwitch: false,
  graceStartedAt: null,
  routeActive: false,
  setRouteActive: () => undefined,
  apply: () => undefined,
  ...over,
});

describe('semver compare', () => {
  it.each([
    ['2.0.0', '2.0.0', 0],
    ['2.0.0', '2.0.1', -1],
    ['2.1.0', '2.0.9', 1],
    ['1.4.2', '2.0.0', -1],
    ['2.0', '2.0.0', 0],
    ['10.0.0', '9.9.9', 1],
  ])('compares %s to %s', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });
});

describe('version gate', () => {
  it('stays out of the way when the build is current', () => {
    expect(gateLevel(state({ minAppVersion: '1.0.0', latestAppVersion: APP_VERSION }))).toBe(
      GateLevel.None,
    );
  });

  it('nudges, without blocking, when a newer build exists', () => {
    expect(gateLevel(state({ minAppVersion: '1.0.0', latestAppVersion: '2.1.0' }))).toBe(
      GateLevel.Nudge,
    );
  });

  it('never hard-blocks mid-route: 60 undelivered parcels beat any bug fix', () => {
    expect(
      gateLevel(state({ minAppVersion: '3.0.0', routeActive: true, graceStartedAt: Date.now() })),
    ).toBe(GateLevel.Grace);
  });

  it('blocks once the route is done', () => {
    expect(gateLevel(state({ minAppVersion: '3.0.0', routeActive: false }))).toBe(
      GateLevel.Blocked,
    );
  });

  it('blocks after the 12 hour grace ceiling even if a route is still open', () => {
    const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
    expect(
      gateLevel(
        state({ minAppVersion: '3.0.0', routeActive: true, graceStartedAt: thirteenHoursAgo }),
      ),
    ).toBe(GateLevel.Blocked);
  });

  it('the kill switch ignores grace: a build that corrupts evidence stops now', () => {
    expect(gateLevel(state({ killSwitch: true, routeActive: true }))).toBe(GateLevel.Blocked);
  });
});
