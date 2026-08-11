import { apiRequest } from '../api/client';
import { syncEngine } from '../sync/sync-engine';
import { getDatabase, setMeta } from './schema';
import { SyncState } from '../sync/state-machine';

export interface StopRow {
  stop_id: string;
  route_date: string;
  seq: number;
  address: string;
  postcode: string;
  lat: number | null;
  lng: number | null;
  status: string;
  removed: number;
  updated_at: string;
}

export interface StopWithSync extends StopRow {
  attempt_count: number;
  worst_sync_state: SyncState | null;
}

interface ServerStop {
  id: string;
  address: string;
  postcode: string;
  sequence: number;
  status: string;
  lat: number | null;
  lng: number | null;
  updated_at: string;
}

/**
 * Today's route, read straight from SQLite. This is what makes a cold start
 * in a basement work: the network is an enhancement, never a dependency.
 */
export async function getTodayStops(): Promise<StopWithSync[]> {
  return getDatabase().getAllAsync<StopWithSync>(
    // Drafts are abandoned or in-flight capture sessions, not recorded work:
    // the stop detail already hides them, and surfacing one here as a stop
    // badge would tell the driver a stop had been attempted when it had not.
    `SELECT s.*,
            (SELECT count(*) FROM attempts a
              WHERE a.stop_id = s.stop_id AND a.sync_state <> 'draft') AS attempt_count,
            (SELECT a.sync_state FROM attempts a
              WHERE a.stop_id = s.stop_id AND a.sync_state <> 'draft'
              ORDER BY CASE a.sync_state
                WHEN 'needs_attention' THEN 5
                WHEN 'submitting' THEN 4
                WHEN 'uploading_media' THEN 4
                WHEN 'attempt_acked' THEN 4
                WHEN 'queued' THEN 3
                ELSE 1 END DESC
              LIMIT 1) AS worst_sync_state
     FROM stops s
     WHERE s.route_date = ?
     ORDER BY s.removed ASC, s.seq ASC`,
    todayKey(),
  );
}

export async function getStop(stopId: string): Promise<StopRow | null> {
  return getDatabase().getFirstAsync<StopRow>(
    'SELECT * FROM stops WHERE stop_id = ?',
    stopId,
  );
}

/** Pulls the route and upserts it. Safe to call as often as we like. */
export async function refreshTodayStops(): Promise<number> {
  const response = await apiRequest<{ stops: ServerStop[] }>('/api/v2/stops');
  const db = getDatabase();
  const routeDate = todayKey();
  const seen = new Set<string>();

  await db.withTransactionAsync(async () => {
    for (const stop of response.stops) {
      seen.add(stop.id);
      await db.runAsync(
        `INSERT INTO stops (stop_id, route_date, seq, address, postcode, lat, lng, status, removed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(stop_id) DO UPDATE SET
           seq = excluded.seq, address = excluded.address, postcode = excluded.postcode,
           lat = excluded.lat, lng = excluded.lng, status = excluded.status,
           removed = 0, updated_at = excluded.updated_at`,
        stop.id,
        routeDate,
        stop.sequence,
        stop.address,
        stop.postcode,
        stop.lat,
        stop.lng,
        stop.status,
        stop.updated_at,
      );
    }

    // Dispatch removed a stop mid-route: tombstone it, never delete it.
    // Any attempts already captured against it remain valid evidence of
    // work done and still upload.
    const local = await db.getAllAsync<{ stop_id: string }>(
      'SELECT stop_id FROM stops WHERE route_date = ?',
      routeDate,
    );
    for (const row of local) {
      if (!seen.has(row.stop_id)) {
        await db.runAsync('UPDATE stops SET removed = 1 WHERE stop_id = ?', row.stop_id);
      }
    }
  });

  await setMeta('last_stops_sync_at', new Date().toISOString());
  // Screens read from SQLite, so they have to be told the cache moved.
  syncEngine.announce();
  return response.stops.length;
}

export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
