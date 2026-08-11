import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchDepotGeoJson, type DepotFeatureCollection } from './api';
import { BlockSkeleton } from './Skeleton';

const STATUS = [
  { code: 0, label: 'Pending', colour: '#64748B' },
  { code: 1, label: 'Attempted', colour: '#B45309' },
  { code: 2, label: 'Delivered', colour: '#0E7C3F' },
  { code: 3, label: 'Failed', colour: '#B3231C' },
] as const;

/**
 * The depot's coverage plotted as a scatter of every stop, drawn to a single
 * canvas rather than as thousands of DOM nodes: the same reasoning as the
 * driver app's map, where 5,000 elements is the difference between a usable
 * screen and a frozen one.
 *
 * Deliberately no basemap tiles here. The office needs to see where work is
 * concentrated and what has settled; a full tiled map is the driver's tool,
 * and this keeps the dashboard free of another mapping dependency.
 */
export function DepotMapPage() {
  const [data, setData] = useState<DepotFeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  useEffect(() => {
    void fetchDepotGeoJson()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  const { points, counts, bounds } = useMemo(() => {
    const features = data?.features ?? [];
    const tally = new Map<number, number>();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const f of features) {
      const [lng, lat] = f.geometry.coordinates;
      tally.set(f.properties.s, (tally.get(f.properties.s) ?? 0) + 1);
      minX = Math.min(minX, lng);
      maxX = Math.max(maxX, lng);
      minY = Math.min(minY, lat);
      maxY = Math.max(maxY, lat);
    }
    return { points: features, counts: tally, bounds: { minX, maxX, minY, maxY } };
  }, [data]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <BlockSkeleton className="h-[32rem]" />;

  const width = 1000;
  const height = 560;
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  const project = (lng: number, lat: number): [number, number] => [
    ((lng - bounds.minX) / spanX) * (width - 40) + 20,
    // Latitude grows upward, screen coordinates grow downward.
    height - (((lat - bounds.minY) / spanY) * (height - 40) + 20),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {STATUS.map((s) => {
          const off = hidden.has(s.code);
          return (
            <button
              key={s.code}
              type="button"
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(s.code)) next.delete(s.code);
                  else next.add(s.code);
                  return next;
                })
              }
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-opacity ${
                off ? 'opacity-40' : ''
              }`}
            >
              <span className="size-2.5 rounded-full" style={{ backgroundColor: s.colour }} />
              {s.label}
              <Badge variant="secondary">{counts.get(s.code) ?? 0}</Badge>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {points.length.toLocaleString()} stops in today&apos;s coverage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full rounded-md bg-muted/30"
            role="img"
            aria-label="Depot coverage scatter plot"
          >
            {points.map((f) => {
              if (hidden.has(f.properties.s)) return null;
              const [x, y] = project(f.geometry.coordinates[0], f.geometry.coordinates[1]);
              const colour = STATUS.find((s) => s.code === f.properties.s)?.colour ?? '#64748B';
              return <circle key={f.properties.id} cx={x} cy={y} r={2.2} fill={colour} opacity={0.75} />;
            })}
          </svg>
          <p className="mt-3 text-xs text-muted-foreground">
            Coordinates and status only. The map payload carries no address, name or driver
            identity, so an operational view never becomes a movement record.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
