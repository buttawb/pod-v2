/**
 * OpenFreeMap Liberty: vector tiles, no API key, no request cap, free for
 * commercial use. Chosen over Google (billing account plus per-marker
 * native views) and over raw OSM raster tiles (the OSMF usage policy
 * forbids redistribution in an app).
 *
 * Attribution stays visible in the map UI: data (c) OpenStreetMap
 * contributors, ODbL.
 */
export const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Documented fallback if OpenFreeMap is unreachable during a demo. */
export const BASEMAP_FALLBACK_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

export const ATTRIBUTION = '(c) OpenStreetMap contributors';

/** Greater London, the seeded depot's coverage area. */
export const DEPOT_CENTER: [number, number] = [-0.1278, 51.5074];
export const DEPOT_ZOOM = 9.5;

/**
 * Status codes are integers, not strings: they keep the ~5,000-feature
 * payload small and make the data-driven `match` expressions cheap to
 * evaluate on the render thread.
 */
export const StatusCode = {
  Pending: 0,
  Attempted: 1,
  Delivered: 2,
  Failed: 3,
} as const;

export type StatusCode = (typeof StatusCode)[keyof typeof StatusCode];

export const STATUS_LABELS: Record<StatusCode, string> = {
  [StatusCode.Pending]: 'Pending',
  [StatusCode.Attempted]: 'Attempted',
  [StatusCode.Delivered]: 'Delivered',
  [StatusCode.Failed]: 'Failed',
};

export const STATUS_COLORS: Record<StatusCode, string> = {
  [StatusCode.Pending]: '#64748B',
  [StatusCode.Attempted]: '#B45309',
  [StatusCode.Delivered]: '#0E7C3F',
  [StatusCode.Failed]: '#B3231C',
};

/**
 * One data-driven expression colours every point on the GPU. Without this
 * the alternative is per-feature React state, which is what makes 5,000
 * markers unusable.
 */
export const STATUS_COLOR_EXPRESSION = [
  'match',
  ['get', 's'],
  StatusCode.Pending,
  STATUS_COLORS[StatusCode.Pending],
  StatusCode.Attempted,
  STATUS_COLORS[StatusCode.Attempted],
  StatusCode.Delivered,
  STATUS_COLORS[StatusCode.Delivered],
  StatusCode.Failed,
  STATUS_COLORS[StatusCode.Failed],
  '#64748B',
];

export function statusCodeFor(status: string): StatusCode {
  switch (status) {
    case 'delivered':
      return StatusCode.Delivered;
    case 'failed':
      return StatusCode.Failed;
    case 'attempted':
      return StatusCode.Attempted;
    default:
      return StatusCode.Pending;
  }
}
