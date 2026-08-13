import type { CameraRef } from '@maplibre/maplibre-react-native';
import { StatusCode } from './basemap';

/**
 * Performance work that can be defended has to be reproducible, so the depot
 * map ships both architectures and one scripted camera tour. Every quoted
 * number comes from running the SAME tour in each mode, on the same device,
 * from the same release build.
 *
 * The two modes are toggled on screen, from the button beside this tour's play
 * button in DepotMapScreen - there is no build flag, deliberately, because a
 * comparison that needs two builds is a comparison of two builds.
 *
 * This previously declared three modes (markers / symbols / clustered) behind
 * an EXPO_PUBLIC_RENDER_MODE variable that nothing ever read: the screen only
 * has the two below, and the constant was dead. A perf harness that describes
 * modes it cannot produce is worse than no harness, because the numbers it
 * labels are then unattributable.
 */
export const RenderMode = {
  /** Before: fetch every stop the depot owns, once, and cluster on device. */
  Legacy: 'legacy',
  /** After (shipped): viewport-scoped, aggregated in Postgres, GPU layers. */
  Viewport: 'viewport',
} as const;

export type RenderMode = (typeof RenderMode)[keyof typeof RenderMode];

export interface TourStats {
  mode: RenderMode;
  durationMs: number;
  steps: number;
}

interface TourStep {
  center: [number, number];
  zoom: number;
  holdMs: number;
  /** Filter toggles are part of the tour: they are a real interaction cost. */
  filter?: StatusCode[];
}

/**
 * Fixed sequence, no randomness: depot overview, dive into dense Zone 1-2,
 * pan across, street level, then back out, with two filter toggles on the
 * way. Preferred over `adb shell input swipe` because adb cannot pinch-zoom
 * and its gesture timing drifts between runs.
 */
const TOUR: TourStep[] = [
  { center: [-0.1278, 51.5074], zoom: 9.5, holdMs: 2000 },
  { center: [-0.0876, 51.5099], zoom: 12.5, holdMs: 2500 },
  { center: [-0.0644, 51.4713], zoom: 14, holdMs: 2500, filter: [StatusCode.Failed, StatusCode.Attempted] },
  { center: [-0.1225, 51.4508], zoom: 13, holdMs: 2500 },
  { center: [-0.1441, 51.5346], zoom: 16, holdMs: 2500, filter: [0, 1, 2, 3] as StatusCode[] },
  { center: [-0.1278, 51.5074], zoom: 9.5, holdMs: 2000 },
];

export async function runCameraTour(
  camera: CameraRef | null,
  setFilter: (statuses: StatusCode[]) => void,
  /** Which architecture is on screen right now; the caller owns the toggle. */
  mode: RenderMode,
): Promise<TourStats> {
  const started = Date.now();

  for (const step of TOUR) {
    if (step.filter) setFilter(step.filter);
    camera?.flyTo({ center: step.center, zoom: step.zoom, duration: 1200 });
    await new Promise((resolve) => setTimeout(resolve, step.holdMs));
  }

  return { mode, durationMs: Date.now() - started, steps: TOUR.length };
}
