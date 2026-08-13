import { StatusCode } from './basemap';
import { routeFeatureCollection, type RouteStop } from './route-features';

function stop(overrides: Partial<RouteStop> = {}): RouteStop {
  return {
    stop_id: 'stop-1',
    seq: 1,
    status: 'pending',
    lat: 51.5074,
    lng: -0.1278,
    removed: 0,
    ...overrides,
  };
}

/**
 * The pin has to agree with the round.
 *
 * A driver reads this map to decide where to go next, so a stale pin is worse
 * here than anywhere else in the app: it does not just misreport, it sends
 * someone to a door they have already been to. The screen used to read the
 * stops once on mount with no subscription, so a delivery recorded a minute
 * ago kept its pending pin until the screen was closed and reopened.
 */
describe('My Route pins', () => {
  it('recolours a stop the moment its status moves, with no remount', () => {
    // The same stop id, re-derived from the row as it stands after an attempt
    // was recorded. This is exactly what a re-read produces, so if the screen
    // re-reads on a sync notification the pin changes underneath the driver.
    const before = routeFeatureCollection([stop({ status: 'pending' })]);
    const after = routeFeatureCollection([stop({ status: 'delivered' })]);

    expect(before.features[0].properties.s).toBe(StatusCode.Pending);
    expect(after.features[0].properties.s).toBe(StatusCode.Delivered);
    expect(after.features[0].properties.id).toBe(before.features[0].properties.id);
  });

  it('maps every status the projection can produce', () => {
    const codes = (status: string) =>
      routeFeatureCollection([stop({ status })]).features[0].properties.s;

    expect(codes('pending')).toBe(StatusCode.Pending);
    expect(codes('attempted')).toBe(StatusCode.Attempted);
    expect(codes('delivered')).toBe(StatusCode.Delivered);
    expect(codes('failed')).toBe(StatusCode.Failed);
    // An unknown status must not crash the map or silently read as delivered.
    expect(codes('something_new')).toBe(StatusCode.Pending);
  });

  it('drops a stop with no coordinates rather than placing it at 0,0', () => {
    // Null Island is not a delivery address, and a pin there would send a
    // driver to the Gulf of Guinea.
    expect(routeFeatureCollection([stop({ lat: null })]).features).toHaveLength(0);
    expect(routeFeatureCollection([stop({ lng: null })]).features).toHaveLength(0);
  });

  it('leaves a cancelled stop off the map without losing it from the round', () => {
    // The map is the work still to be driven. The list is where a cancelled
    // stop stays visible, with any evidence already captured against it.
    expect(routeFeatureCollection([stop({ removed: 1 })]).features).toHaveLength(0);
  });

  it('carries the sequence so the pin can be labelled in round order', () => {
    const c = routeFeatureCollection([stop({ seq: 42 }), stop({ stop_id: 'b', seq: 43 })]);
    expect(c.features.map((f) => f.properties.q)).toEqual([42, 43]);
  });
});
