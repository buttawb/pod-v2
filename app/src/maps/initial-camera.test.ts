import { DEPOT_CENTER } from './basemap';
import { resolveInitialCamera, zoomFor } from './initial-camera';

const KARACHI = { lat: 24.8607, lng: 67.0011 };

describe('where a map opens', () => {
  it('opens on the device position when there is one', () => {
    const target = resolveInitialCamera(KARACHI, null);

    expect(target.source).toBe('device');
    // GeoJSON order: longitude first. Getting this backwards puts a Karachi
    // driver in the Indian Ocean, which is exactly the class of bug this
    // module exists to stop being written twice.
    expect(target.center).toEqual([67.0011, 24.8607]);
  });

  it('prefers the device over the round when the round is near enough to work', () => {
    // A stop across the city. The driver is plausibly on this round, so their
    // own position is the more useful centre.
    const target = resolveInitialCamera(KARACHI, [67.05, 24.9]);

    expect(target.source).toBe('device');
    expect(target.center).toEqual([67.0011, 24.8607]);
  });

  it('shows the round instead when the driver is nowhere near it', () => {
    // This assertion used to demand the opposite, and that was the bug. A
    // Karachi handset holding a London round opened on Karachi, where the
    // driver owns no stops at all, so the screen came up empty and read as
    // broken. An empty map centred on the driver is worth less than a map of
    // the work, however far away the work is.
    const target = resolveInitialCamera(KARACHI, [-0.1278, 51.5074]);

    expect(target.source).toBe('round');
    expect(target.center).toEqual([-0.1278, 51.5074]);
  });

  it('falls back to the round when the fix is refused or unavailable', () => {
    // Permission denied, location services off, or indoors and slow. The map
    // must still open on something the driver recognises.
    const target = resolveInitialCamera(null, [67.05, 24.9]);

    expect(target.source).toBe('round');
    expect(target.center).toEqual([67.05, 24.9]);
  });

  it('falls back to the depot when there is neither a fix nor a loaded round', () => {
    const target = resolveInitialCamera(null, null);

    expect(target.source).toBe('depot');
    expect(target.center).toEqual(DEPOT_CENTER);
  });

  it('treats 0,0 as no fix rather than as the Atlantic', () => {
    // A failed fix defaulted to zero is the classic Null Island bug. The rest
    // of this codebase stores a failed fix as null; this guards the case where
    // something upstream has not.
    const target = resolveInitialCamera({ lat: 0, lng: 0 }, [67.05, 24.9]);

    expect(target.source).toBe('round');
  });

  it('ignores a non-finite fix', () => {
    expect(resolveInitialCamera({ lat: Number.NaN, lng: 67 }, null).source).toBe('depot');
    expect(resolveInitialCamera({ lat: 24.8, lng: Number.POSITIVE_INFINITY }, null).source).toBe(
      'depot',
    );
  });

  it('zooms closer when the centre is the driver, and stays wide otherwise', () => {
    // Opening tight on a depot centre nobody is standing at shows empty map;
    // opening wide on the driver wastes the one thing worth centring on.
    expect(zoomFor('device', 9.5)).toBeGreaterThan(9.5);
    expect(zoomFor('round', 9.5)).toBe(9.5);
    expect(zoomFor('depot', 9.5)).toBe(9.5);
  });
});
