import { create } from 'zustand';
import { APP_VERSION } from '../config';

const GRACE_STARTED_KEY = 'version_grace_started_at';

/**
 * Persistence is injected rather than imported so this module stays free of
 * native dependencies: the gate is pure decision logic and has to remain
 * unit-testable off-device.
 */
export interface GraceStore {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string) => Promise<void>;
}

let graceStore: GraceStore | null = null;

export function configureGraceStore(store: GraceStore): void {
  graceStore = store;
}

/**
 * Two levers, two severities:
 *  - minAppVersion  = "must update, humanely" -> grace until the route ends
 *  - killSwitch     = "this build is dangerous" -> block immediately
 *
 * Both block NEW CAPTURES only. Uploading already-captured evidence is
 * always allowed: stranding proof on a handset costs more than any bug an
 * update fixes, and a driver who fears losing their work will dodge updates.
 */
export const GateLevel = {
  None: 'none',
  /** Dismissible nudge: a newer build exists. */
  Nudge: 'nudge',
  /** Must update, but not mid-route: banner now, block at end of shift. */
  Grace: 'grace',
  /** New captures blocked. Sync and upload still work. */
  Blocked: 'blocked',
} as const;

export type GateLevel = (typeof GateLevel)[keyof typeof GateLevel];

interface VersionPolicy {
  minAppVersion: string | null;
  latestAppVersion: string | null;
  killSwitch: boolean;
}

interface VersionGateStore extends VersionPolicy {
  /** Set when a min-version raise is first seen while a route is active. */
  graceStartedAt: number | null;
  routeActive: boolean;
  setRouteActive: (active: boolean) => void;
  apply: (policy: VersionPolicy) => void;
}

const GRACE_CEILING_MS = 12 * 60 * 60 * 1000;

export const useVersionGate = create<VersionGateStore>((set) => ({
  minAppVersion: null,
  latestAppVersion: null,
  killSwitch: false,
  graceStartedAt: null,
  routeActive: false,
  setRouteActive: (routeActive) => set({ routeActive }),
  apply: (policy) =>
    set((state) => {
      const belowMin = policy.minAppVersion
        ? compareSemver(APP_VERSION, policy.minAppVersion) < 0
        : false;
      if (!belowMin) {
        if (state.graceStartedAt !== null) void graceStore?.write(GRACE_STARTED_KEY, '');
        return { ...policy, graceStartedAt: null };
      }
      if (state.graceStartedAt !== null) return { ...policy, graceStartedAt: state.graceStartedAt };

      // The grace clock is persisted, not held in memory: otherwise every
      // relaunch would restart it and a driver could dodge a required
      // update indefinitely by force-quitting the app.
      const startedAt = Date.now();
      void graceStore?.write(GRACE_STARTED_KEY, String(startedAt));
      return { ...policy, graceStartedAt: startedAt };
    }),
}));

/** Restores the persisted grace clock during boot, before any gate is evaluated. */
export async function restoreGraceClock(): Promise<void> {
  const stored = (await graceStore?.read(GRACE_STARTED_KEY)) ?? null;
  const startedAt = stored ? Number(stored) : Number.NaN;
  if (Number.isFinite(startedAt) && startedAt > 0) {
    useVersionGate.setState({ graceStartedAt: startedAt });
  }
}

export function recordVersionHeaders(policy: VersionPolicy): void {
  if (!policy.minAppVersion && !policy.latestAppVersion && !policy.killSwitch) return;
  useVersionGate.getState().apply(policy);
}

export function gateLevel(state = useVersionGate.getState(), now = Date.now()): GateLevel {
  // The kill switch ignores grace by design: we accept the operational
  // damage because a build that corrupts evidence is worse.
  if (state.killSwitch) return GateLevel.Blocked;

  const belowMin = state.minAppVersion
    ? compareSemver(APP_VERSION, state.minAppVersion) < 0
    : false;

  if (belowMin) {
    const graceExpired =
      state.graceStartedAt !== null && now - state.graceStartedAt > GRACE_CEILING_MS;
    // A driver blocked mid-route with 60 undelivered parcels is 60 failed
    // deliveries; the route (or a 12h ceiling) has to finish first.
    if (state.routeActive && !graceExpired) return GateLevel.Grace;
    return GateLevel.Blocked;
  }

  const behindLatest = state.latestAppVersion
    ? compareSemver(APP_VERSION, state.latestAppVersion) < 0
    : false;
  return behindLatest ? GateLevel.Nudge : GateLevel.None;
}

/** -1 if a < b, 0 if equal, 1 if a > b. Tolerates missing segments. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
