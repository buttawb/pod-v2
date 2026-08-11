import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FullscreenControl,
  GeoJSONSource,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Served verbatim by the maplibre-worker-passthrough plugin in vite.config.ts,
// which is also where the reasoning lives. Must be an absolute path: the
// dashboard is a single-page app, so a relative one would resolve against
// whatever route the operator happens to be on.
setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`);
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { fetchDepotGeoJson, type DepotFeatureCollection } from './api';
import { BlockSkeleton } from './Skeleton';

const STATUS = [
  { code: 0, label: 'Pending', colour: '#64748B' },
  { code: 1, label: 'Attempted', colour: '#B45309' },
  { code: 2, label: 'Delivered', colour: '#0E7C3F' },
  { code: 3, label: 'Failed', colour: '#B3231C' },
] as const;

const ALL_CODES = STATUS.map((s) => s.code);

/** Same basemap as the driver app: vector tiles, no API key, no request cap. */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * The depot's whole coverage on one map.
 *
 * Same approach the driver app takes, and for the same reason: one GeoJSON
 * source rendered by GPU style layers, clustered, with filtering done by
 * swapping a layer filter expression rather than re-uploading the data.
 * Thousands of DOM markers is what makes this screen unusable.
 */
export function DepotMapPage() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [data, setData] = useState<DepotFeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void fetchDepotGeoJson()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  const counts = useMemo(() => {
    const tally = new Map<number, number>();
    for (const f of data?.features ?? []) {
      tally.set(f.properties.s, (tally.get(f.properties.s) ?? 0) + 1);
    }
    return tally;
  }, [data]);

  // Build the map once the data is in hand, so the source is set exactly once.
  useEffect(() => {
    if (!container.current || !data || map.current) return;

    const instance = new MapLibreMap({
      container: container.current,
      style: STYLE_URL,
      center: [-0.1278, 51.5074],
      zoom: 9.2,
      attributionControl: { compact: true },
    });
    map.current = instance;
    instance.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new FullscreenControl(), 'top-right');

    // The map measures its container once, at construction. This card is laid
    // out by flex inside a scroll area, so its final width often arrives a
    // frame later; without this the canvas keeps whatever width it saw first
    // and the rest of the card stays empty.
    const resizeObserver = new ResizeObserver(() => instance.resize());
    resizeObserver.observe(container.current);

    // A style or tile failure is otherwise silent: the basemap background
    // paints and the map simply stays empty, which reads as "no data".
    instance.on('error', (event) => {
      console.error('maplibre:', event.error?.message ?? event);
    });

    // `style.load`, not `load`. `load` waits for the style AND the sprite's
    // image manager AND the first tile batch; against this basemap it never
    // settles, so the source and layers were simply never added and the map
    // showed a bare basemap with no errors. Adding layers only requires the
    // style to be parsed, which is exactly what `style.load` reports.
    instance.on('style.load', () => {
      if (instance.getSource('stops')) return;

      instance.addSource('stops', {
        type: 'geojson',
        data: data as GeoJSON.FeatureCollection,
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 13,
      });

      instance.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'stops',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#0B5FD6',
          'circle-opacity': 0.85,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#FFFFFF',
          'circle-radius': ['step', ['get', 'point_count'], 16, 50, 22, 200, 30],
        },
      });

      instance.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'stops',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          // Named explicitly: MapLibre's default stack is not one OpenFreeMap
          // hosts, so the glyph request 404s and the counts render as nothing.
          'text-font': ['Noto Sans Regular'],
          'text-size': 12,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#FFFFFF' },
      });

      instance.addLayer({
        id: 'stops-points',
        type: 'circle',
        source: 'stops',
        filter: ['!', ['has', 'point_count']],
        paint: {
          // One data-driven expression colours every stop on the GPU.
          'circle-color': [
            'match',
            ['get', 's'],
            0, STATUS[0].colour,
            1, STATUS[1].colour,
            2, STATUS[2].colour,
            3, STATUS[3].colour,
            '#64748B',
          ],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 6, 17, 9],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#FFFFFF',
        },
      });

      // Clicking a cluster zooms to where it breaks apart.
      instance.on('click', 'clusters', (event) => {
        const feature = instance.queryRenderedFeatures(event.point, { layers: ['clusters'] })[0];
        const clusterId = feature?.properties?.cluster_id as number | undefined;
        if (clusterId === undefined) return;
        const source = instance.getSource('stops') as GeoJSONSource;
        void source.getClusterExpansionZoom(clusterId).then((zoom) => {
          instance.easeTo({
            center: (feature.geometry as GeoJSON.Point).coordinates as [number, number],
            zoom,
          });
        });
      });

      for (const layer of ['clusters', 'stops-points']) {
        instance.on('mouseenter', layer, () => {
          instance.getCanvas().style.cursor = 'pointer';
        });
        instance.on('mouseleave', layer, () => {
          instance.getCanvas().style.cursor = '';
        });
      }

      setReady(true);
    });

    return () => {
      resizeObserver.disconnect();
      instance.remove();
      map.current = null;
    };
  }, [data]);

  // Filtering swaps an expression; the 5,000 features are never re-uploaded.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const visible = ALL_CODES.filter((code) => !hidden.has(code));
    instance.setFilter('stops-points', [
      'all',
      ['!', ['has', 'point_count']],
      ['in', ['get', 's'], ['literal', visible]],
    ]);
  }, [hidden, ready]);

  const toggle = useCallback((code: number) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <BlockSkeleton className="h-[34rem]" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS.map((s) => {
          const off = hidden.has(s.code);
          return (
            <button
              key={s.code}
              type="button"
              onClick={() => toggle(s.code)}
              className={`flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm transition-opacity ${
                off ? 'opacity-40' : ''
              }`}
            >
              <span className="size-2.5 rounded-full" style={{ backgroundColor: s.colour }} />
              {s.label}
              <Badge variant="secondary">{counts.get(s.code) ?? 0}</Badge>
            </button>
          );
        })}
        <span className="ml-auto text-sm text-muted-foreground">
          {data.features.length.toLocaleString()} stops
        </span>
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div ref={container} className="h-[34rem] w-full" />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Coordinates and status only. The map payload carries no address, name or driver identity,
        so an operational view never becomes a movement record.
      </p>
    </div>
  );
}
