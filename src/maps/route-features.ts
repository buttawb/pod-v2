import { statusCodeFor, type StatusCode } from './basemap';

/**
 * The driver's own round, as map pins.
 *
 * Extracted from the screen so it can be tested: Jest here collects
 * `**​/src/**​/*.test.ts` and never `.tsx`, so anything that has to be proven
 * belongs in a plain module. The screen keeps the MapLibre wiring and this
 * keeps the rule about what a pin means.
 */
export interface RouteStop {
  stop_id: string;
  seq: number;
  status: string;
  lat: number | null;
  lng: number | null;
  removed: number;
}

export interface RouteFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { id: string; s: StatusCode; q: number };
}

export interface RouteFeatureCollection {
  type: 'FeatureCollection';
  features: RouteFeature[];
}

/**
 * A pin exists only where there is somewhere to put it and something to do.
 *
 * Stops without coordinates are dropped rather than placed at 0,0: an
 * unplaceable stop is not a stop in the Gulf of Guinea. Stops dispatch pulled
 * are dropped too, because the map is the work still to be driven, and the
 * list is where a cancelled stop stays visible with any evidence against it.
 *
 * The colour comes from the stop's status, which is projected from its latest
 * attempt. That is what makes a pin change the moment an attempt is recorded,
 * provided the screen re-reads.
 */
export function routeFeatureCollection(stops: RouteStop[]): RouteFeatureCollection {
  const features = stops
    .filter((s) => s.lat !== null && s.lng !== null && s.removed === 0)
    .map<RouteFeature>((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng as number, s.lat as number] },
      properties: { id: s.stop_id, s: statusCodeFor(s.status), q: s.seq },
    }));

  return { type: 'FeatureCollection', features };
}
