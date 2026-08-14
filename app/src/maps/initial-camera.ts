import { DEPOT_CENTER } from './basemap';

/**
 * Where a map should open.
 *
 * Both maps used to open on a hardcoded London centre, or on the first stop of
 * the round. Neither is where the driver is. A Karachi driver opening the depot
 * map landed on London and had to pan across a continent before seeing a single
 * pin, which reads as broken rather than as a default.
 *
 * So the device's own position wins when there is one. It is the only centre
 * that is right for every depot without the app knowing which depot exists, and
 * it is what a driver means by "the map".
 *
 * The fallbacks matter as much as the rule. A fix can be refused, switched off
 * or simply slow, and the map still has to open somewhere sensible: the round
 * the driver is holding, and only then the depot centre. Opening on a spinner
 * while waiting for GPS would be the worst of the three.
 */
export type Coordinate = [number, number];

export interface CameraTarget {
  center: Coordinate;
  /** Where it came from, so a caller can zoom differently and tests can assert. */
  source: 'device' | 'round' | 'depot';
}

/**
 * `fix` is the device position, null while unknown or unavailable.
 * `firstStop` is the first coordinate of the driver's own round, if loaded.
 */
/**
 * How far the driver can be from their own round before the round wins.
 *
 * Roughly 150km, compared as a great-circle distance. Inside that, the driver is
 * plausibly working the round and their own position is the useful centre.
 * Outside it they are not, and centring on them shows an empty map with their
 * work somewhere off the edge, which is exactly what "my route shows no stops"
 * looks like from the driver's side.
 */
const NEAR_ROUND_KM = 150;

function distanceKm(a: Coordinate, b: Coordinate): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [aLng, aLat] = a;
  const [bLng, bLat] = b;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function resolveInitialCamera(
  fix: { lat: number; lng: number } | null,
  firstStop?: Coordinate | null,
): CameraTarget {
  const round: Coordinate | null =
    firstStop && Number.isFinite(firstStop[0]) && Number.isFinite(firstStop[1])
      ? firstStop
      : null;

  // Longitude first: GeoJSON order, which is what the map engine takes and the
  // opposite of how a person says a coordinate out loud.
  //
  // 0,0 is in the Atlantic and is what a failed fix looks like when someone has
  // defaulted it to zero rather than left it null.
  const usable =
    fix &&
    Number.isFinite(fix.lat) &&
    Number.isFinite(fix.lng) &&
    (fix.lat !== 0 || fix.lng !== 0);

  if (usable) {
    const device: Coordinate = [fix.lng, fix.lat];
    // The driver's own position only wins if their work is near it. Preferring
    // the fix unconditionally was wrong: a driver in Karachi holding a London
    // round opened on Karachi and saw nothing, because every stop they own was
    // a continent away. Showing the work beats showing the standing spot.
    if (!round || distanceKm(device, round) <= NEAR_ROUND_KM) {
      return { center: device, source: 'device' };
    }
    return { center: round, source: 'round' };
  }

  if (round) return { center: round, source: 'round' };

  return { center: DEPOT_CENTER, source: 'depot' };
}

/** Closer in when we know where the driver actually is. */
export function zoomFor(source: CameraTarget['source'], depotZoom: number): number {
  return source === 'device' ? 13.5 : depotZoom;
}

/**
 * The depot overview opens at country scale on purpose.
 *
 * It answers "where is the work today", which is a question about the whole
 * coverage area rather than the street the driver happens to be on. At this
 * zoom the server returns aggregated cells rather than individual stops, so
 * the first paint is a handful of cluster bubbles over the cities instead of
 * thousands of pins, and panning in resolves them into real stops.
 */
export const DEPOT_COUNTRY_ZOOM = 5.2;
