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
export function resolveInitialCamera(
  fix: { lat: number; lng: number } | null,
  firstStop?: Coordinate | null,
): CameraTarget {
  // Longitude first: GeoJSON order, which is what the map engine takes and the
  // opposite of how a person says a coordinate out loud.
  if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng)) {
    // 0,0 is in the Atlantic and is what a failed fix looks like when someone
    // has defaulted it to zero rather than left it null.
    if (fix.lat !== 0 || fix.lng !== 0) {
      return { center: [fix.lng, fix.lat], source: 'device' };
    }
  }

  if (firstStop && Number.isFinite(firstStop[0]) && Number.isFinite(firstStop[1])) {
    return { center: firstStop, source: 'round' };
  }

  return { center: DEPOT_CENTER, source: 'depot' };
}

/** Closer in when we know where the driver actually is. */
export function zoomFor(source: CameraTarget['source'], depotZoom: number): number {
  return source === 'device' ? 13.5 : depotZoom;
}
