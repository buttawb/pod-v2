import type { CameraRef } from '@maplibre/maplibre-react-native';
import { StatusCode } from './basemap';

/**
 * Performance work that can be defended has to be reproducible, so the
 * depot map ships with three render modes and one scripted camera tour.
 * Every quoted number in DECISIONS.md comes from running the SAME tour in
 * each mode, on the same device, from a release build.
 *
 * Switch with:  EXPO_PUBLIC_RENDER_MODE=markers|symbols|clustered
 */
export const RenderMode = {
  /** Naive baseline: one native view per stop (what most implementations do). */
  Markers: 'markers',
  /** GPU layer, but unclustered symbols pay collision detection per frame. */
  Symbols: 'symbols',
  /** Shipped: clustered circles with data-driven colour. */
  Clustered: 'clustered',
} as const;

export type RenderMode = (typeof RenderMode)[keyof typeof RenderMode];

export const RENDER_MODE: RenderMode =
  (process.env.EXPO_PUBLIC_RENDER_MODE as RenderMode | undefined) ?? RenderMode.Clustered;

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
): Promise<TourStats> {
  const started = Date.now();

  for (const step of TOUR) {
    if (step.filter) setFilter(step.filter);
    camera?.flyTo({ center: step.center, zoom: step.zoom, duration: 1200 });
    await new Promise((resolve) => setTimeout(resolve, step.holdMs));
  }

  return { mode: RENDER_MODE, durationMs: Date.now() - started, steps: TOUR.length };
}
