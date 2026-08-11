import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  type CameraRef,
  type GeoJSONSourceRef,
} from '@maplibre/maplibre-react-native';
import { apiRequest } from '../api/client';
import { BottomBar, Button, colors, spacing, type } from '../ui/components';
import {
  ATTRIBUTION,
  BASEMAP_STYLE_URL,
  DEPOT_CENTER,
  DEPOT_ZOOM,
  STATUS_COLOR_EXPRESSION,
  STATUS_COLORS,
  STATUS_LABELS,
  StatusCode,
} from './basemap';
import { RENDER_MODE, RenderMode, runCameraTour, type TourStats } from './perf-harness';
import type { NativeSyntheticEvent } from 'react-native';
import type { PressEventWithFeatures } from '@maplibre/maplibre-react-native';

interface DepotFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { id: string; s: StatusCode; q: number };
  }>;
}

const ALL_STATUSES: StatusCode[] = [
  StatusCode.Pending,
  StatusCode.Attempted,
  StatusCode.Delivered,
  StatusCode.Failed,
];

/**
 * Every stop in the depot's coverage area on one map, filterable by status,
 * and interactive on a mid-range handset.
 *
 * The design that makes that possible: ONE GeoJSON source handed to the
 * native side once, rendered by GPU style layers. There is no React
 * component per stop, so panning costs no JavaScript at all. Filtering
 * swaps a layer `filter` expression (a sub-kilobyte prop diff) rather than
 * re-uploading the feature collection.
 *
 * Two sources, not one: cluster aggregation happens at the SOURCE level,
 * before layer filters run, so filtering a clustered source would leave
 * cluster bubbles counting stops that are no longer displayed. The flat
 * source is shown only while a filter is active.
 */
export function DepotMapScreen({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<DepotFeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<StatusCode>>(new Set(ALL_STATUSES));
  const [tourStats, setTourStats] = useState<TourStats | null>(null);
  const cameraRef = useRef<CameraRef>(null);
  const sourceRef = useRef<GeoJSONSourceRef>(null);

  useEffect(() => {
    void (async () => {
      try {
        setData(await apiRequest<DepotFeatureCollection>('/api/v2/depot/stops.geojson'));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load depot stops');
      }
    })();
  }, []);

  const filtering = selected.size < ALL_STATUSES.length;

  // A layer filter is compiled into the native render pass; toggling it
  // never touches the 5,000-feature payload.
  const statusFilter = useMemo(
    () => ['in', ['get', 's'], ['literal', [...selected]]] as never,
    [selected],
  );

  const toggle = useCallback((status: StatusCode) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next.size === 0 ? new Set(ALL_STATUSES) : next;
    });
  }, []);

  const onPress = useCallback(async (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
    const feature = event.nativeEvent.features[0];
    if (!feature) return;
    const props = feature.properties as { cluster?: boolean; cluster_id?: number } | null;
    if (props?.cluster && props.cluster_id !== undefined) {
      const zoom = await sourceRef.current?.getClusterExpansionZoom(props.cluster_id);
      const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
      cameraRef.current?.easeTo({ center: [lng, lat], zoom: zoom ?? 12, duration: 400 });
    }
  }, []);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={type.body}>{error}</Text>
        <Button label="Back" variant="secondary" onPress={onBack} />
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={type.small}>Loading depot stops</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Map style={styles.map} mapStyle={BASEMAP_STYLE_URL} attribution logo={false}>
        <Camera
          ref={cameraRef}
          initialViewState={{ center: DEPOT_CENTER, zoom: DEPOT_ZOOM }}
        />

        {RENDER_MODE === RenderMode.Markers ? (
          // Measurement baseline only: one native view per stop. This is what
          // the naive implementation costs, and it is why the shipped design
          // uses style layers instead.
          <>
            {data.features.slice(0, MARKER_BASELINE_LIMIT).map((f) => (
              <Marker key={f.properties.id} lngLat={f.geometry.coordinates}>
                <View
                  style={[styles.markerDot, { backgroundColor: STATUS_COLORS[f.properties.s] }]}
                />
              </Marker>
            ))}
          </>
        ) : RENDER_MODE === RenderMode.Symbols ? (
          // Middle option: GPU layer, but unclustered symbols pay for collision
          // detection on every frame.
          <GeoJSONSource id="stops-flat" data={data} onPress={onPress}>
            <Layer
              id="stops-symbols"
              type="symbol"
              layout={{ 'icon-image': 'marker-15', 'icon-allow-overlap': false }}
            />
          </GeoJSONSource>
        ) : (
          <>
            {/* Shipped design: clustered source for the overview. */}
            <GeoJSONSource
              id="stops-clustered"
              ref={sourceRef}
              data={data}
              cluster={!filtering}
              clusterRadius={50}
              clusterMaxZoom={14}
              onPress={onPress}
            >
              <Layer
                id="clusters"
                type="circle"
                filter={['has', 'point_count'] as never}
                layout={{ visibility: filtering ? 'none' : 'visible' }}
                paint={{
                  'circle-color': '#0B5FD6',
                  'circle-opacity': 0.85,
                  'circle-stroke-width': 2,
                  'circle-stroke-color': '#FFFFFF',
                  'circle-radius': [
                    'step',
                    ['get', 'point_count'],
                    14,
                    25,
                    18,
                    100,
                    24,
                  ] as never,
                }}
              />
              <Layer
                id="cluster-count"
                type="symbol"
                filter={['has', 'point_count'] as never}
                layout={{
                  visibility: filtering ? 'none' : 'visible',
                  'text-field': ['get', 'point_count_abbreviated'] as never,
                  'text-size': 13,
                  'text-allow-overlap': true,
                }}
                paint={{ 'text-color': '#FFFFFF' }}
              />
              <Layer
                id="stops-unclustered"
                type="circle"
                filter={['!', ['has', 'point_count']] as never}
                layout={{ visibility: filtering ? 'none' : 'visible' }}
                paint={{
                  // Circles, not icon symbols: one instanced GPU draw with no
                  // icon-atlas lookup and no collision pass.
                  'circle-color': STATUS_COLOR_EXPRESSION as never,
                  'circle-radius': 5,
                  'circle-stroke-width': 1,
                  'circle-stroke-color': '#FFFFFF',
                }}
              />
            </GeoJSONSource>

            {/* Flat source, shown only while filtering, so cluster counts can
                never disagree with what is on screen. */}
            <GeoJSONSource id="stops-filtered-source" data={data} cluster={false} onPress={onPress}>
              <Layer
                id="stops-filtered"
                type="circle"
                filter={statusFilter}
                layout={{ visibility: filtering ? 'visible' : 'none' }}
                paint={{
                  'circle-color': STATUS_COLOR_EXPRESSION as never,
                  'circle-radius': 5,
                  'circle-stroke-width': 1,
                  'circle-stroke-color': '#FFFFFF',
                }}
              />
            </GeoJSONSource>
          </>
        )}
      </Map>

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.chips}>
          {ALL_STATUSES.map((status) => {
            const on = selected.has(status);
            return (
              <Pressable
                key={status}
                onPress={() => toggle(status)}
                style={[
                  styles.chip,
                  on && { backgroundColor: STATUS_COLORS[status], borderColor: STATUS_COLORS[status] },
                ]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>
                  {STATUS_LABELS[status]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.meta}>
          {data.features.length} stops · {RENDER_MODE} · {ATTRIBUTION}
        </Text>
        {tourStats ? (
          <Text style={styles.meta}>
            tour {tourStats.durationMs}ms · {tourStats.steps} steps
          </Text>
        ) : null}
      </View>

      <BottomBar>
        {__DEV__ ? (
          <Button
            label="Run camera tour (perf)"
            variant="secondary"
            onPress={() => {
              void runCameraTour(cameraRef.current, (status) => setSelected(new Set(status))).then(
                setTourStats,
              );
            }}
          />
        ) : null}
        <Button label="Back" variant="secondary" onPress={onBack} />
      </BottomBar>
    </View>
  );
}

/** The marker baseline OOMs well before 5,000; we bisect and report where. */
const MARKER_BASELINE_LIMIT = 1500;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  map: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  overlay: { position: 'absolute', top: spacing.sm, left: spacing.sm, right: spacing.sm, gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.text },
  chipTextOn: { color: '#FFFFFF' },
  meta: {
    fontSize: 11,
    color: colors.text,
    backgroundColor: 'rgba(255,255,255,0.85)',
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  markerDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
});
