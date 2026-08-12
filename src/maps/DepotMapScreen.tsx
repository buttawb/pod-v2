import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  type CameraRef,
  type MapRef,
} from '@maplibre/maplibre-react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiRequest } from '../api/client';
import { colors, radius, shadow, spacing, type } from '../ui/components';
import {
  ATTRIBUTION,
  BASEMAP_STYLE_URL,
  CLUSTER_COLOR,
  DEPOT_CENTER,
  DEPOT_ZOOM,
  GLYPH_FONT,
  STATUS_COLOR_EXPRESSION,
  STATUS_COLORS,
  STATUS_LABELS,
  StatusCode,
} from './basemap';
import type { NativeSyntheticEvent } from 'react-native';
import type { ViewStateChangeEvent } from '@maplibre/maplibre-react-native';

interface DepotResponse {
  type: 'FeatureCollection';
  /** The server decides: aggregated cells when zoomed out, real stops when in. */
  mode: 'clustered' | 'points';
  truncated?: boolean;
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { id?: string; s?: StatusCode; q?: number; point_count?: number };
  }>;
}

const ALL_STATUSES: StatusCode[] = [
  StatusCode.Pending,
  StatusCode.Attempted,
  StatusCode.Delivered,
  StatusCode.Failed,
];

const STATUS_PARAM: Record<StatusCode, string> = {
  [StatusCode.Pending]: 'pending',
  [StatusCode.Attempted]: 'attempted',
  [StatusCode.Delivered]: 'delivered',
  [StatusCode.Failed]: 'failed',
};

/** Panning fires continuously; only the settled viewport is worth a request. */
const SETTLE_MS = 350;

const EMPTY: DepotResponse = { type: 'FeatureCollection', mode: 'points', features: [] };

/**
 * The depot's coverage, loaded a viewport at a time.
 *
 * The whole day is thousands of stops, and a handset should never hold all of
 * them to draw one screen. Each settled pan or zoom asks the server for just
 * this rectangle, and the server decides the shape of the answer: zoomed out
 * it aggregates into counted cells in Postgres, so a country-wide view costs
 * one small response instead of every stop the depot owns; zoomed in past
 * street level it returns real stops, capped, and says so if it had to cut.
 *
 * Clustering therefore happens in the database rather than on the device. That
 * is the trade: it costs a request per settled gesture, and it means a low-end
 * phone never parses or holds a payload that grows with the fleet.
 */
export function DepotMapScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<DepotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<StatusCode>>(new Set(ALL_STATUSES));
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewport = useRef<{ bbox: string; zoom: number } | null>(null);
  // Rising id: a slow response for an old viewport must never overwrite a
  // newer one that already arrived.
  const requestId = useRef(0);

  const load = useCallback(async (bbox: string, zoom: number, statuses: Set<StatusCode>) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ bbox, zoom: zoom.toFixed(2) });
      if (statuses.size < ALL_STATUSES.length) {
        params.set('status', [...statuses].map((s) => STATUS_PARAM[s]).join(','));
      }
      const response = await apiRequest<DepotResponse>(
        `/api/v2/depot/stops.geojson?${params.toString()}`,
      );
      if (id !== requestId.current) return;
      setData(response);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : 'Could not load depot stops');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  /**
   * The first viewport is not a gesture, so nothing would request it. Read the
   * bounds off the map once it is ready rather than assuming what they are
   * from the initial centre and zoom, which ignores the screen's aspect.
   */
  const onDidFinishLoadingMap = useCallback(() => {
    void (async () => {
      const map = mapRef.current;
      if (!map) return;
      const [bounds, zoom] = await Promise.all([map.getBounds(), map.getZoom()]);
      const [west, south, east, north] = bounds;
      viewport.current = { bbox: `${west},${south},${east},${north}`, zoom };
      await load(viewport.current.bbox, zoom, selected);
    })();
  }, [load, selected]);

  const onRegionDidChange = useCallback(
    (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      const { bounds, zoom } = event.nativeEvent;
      const [west, south, east, north] = bounds;
      viewport.current = { bbox: `${west},${south},${east},${north}`, zoom };

      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        const current = viewport.current;
        if (current) void load(current.bbox, current.zoom, selected);
      }, SETTLE_MS);
    },
    [load, selected],
  );

  // Filtering is a server concern now, because the counts in an aggregated
  // cell have to be counts of what passes the filter.
  useEffect(() => {
    const current = viewport.current;
    if (current) void load(current.bbox, current.zoom, selected);
  }, [selected, load]);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const toggle = useCallback((status: StatusCode) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next.size === 0 ? new Set(ALL_STATUSES) : next;
    });
  }, []);

  const collection = data ?? EMPTY;
  const clustered = collection.mode === 'clustered';
  const shown = clustered
    ? collection.features.reduce((sum, f) => sum + (f.properties.point_count ?? 0), 0)
    : collection.features.length;

  return (
    <View style={styles.container}>
      <Map
        ref={mapRef}
        style={styles.map}
        mapStyle={BASEMAP_STYLE_URL}
        attribution
        logo={false}
        onDidFinishLoadingMap={onDidFinishLoadingMap}
        onRegionDidChange={onRegionDidChange}
      >
        <Camera ref={cameraRef} initialViewState={{ center: DEPOT_CENTER, zoom: DEPOT_ZOOM }} />

        {/* One source, reshaped by the server. Nothing is clustered on the
            device, so panning costs no JavaScript beyond the fetch. */}
        <GeoJSONSource id="depot" data={collection as never} cluster={false}>
          <Layer
            id="depot-cells"
            type="circle"
            filter={['has', 'point_count'] as never}
            paint={{
              'circle-color': CLUSTER_COLOR,
              'circle-opacity': 0.85,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#FFFFFF',
              'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 100, 24] as never,
            }}
          />
          <Layer
            id="depot-cell-counts"
            type="symbol"
            filter={['has', 'point_count'] as never}
            layout={{
              'text-field': ['get', 'point_count'] as never,
              'text-font': GLYPH_FONT,
              'text-size': 13,
              'text-allow-overlap': true,
            }}
            paint={{ 'text-color': '#FFFFFF' }}
          />
          <Layer
            id="depot-stops"
            type="circle"
            filter={['!', ['has', 'point_count']] as never}
            paint={{
              // Circles, not icon symbols: one instanced GPU draw, no icon
              // atlas lookup and no collision pass.
              'circle-color': STATUS_COLOR_EXPRESSION as never,
              'circle-radius': 5,
              'circle-stroke-width': 1,
              'circle-stroke-color': '#FFFFFF',
            }}
          />
        </GeoJSONSource>
      </Map>

      <View
        style={[
          styles.overlay,
          {
            top: insets.top + spacing.sm,
            left: insets.left + spacing.md,
            right: insets.right + spacing.md,
          },
        ]}
        pointerEvents="box-none"
      >
        <View style={styles.topRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to maps"
            onPress={onBack}
            style={styles.floatingButton}
          >
            <Feather name="chevron-left" size={22} color={colors.text} />
          </Pressable>
          <View style={styles.countPill}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Text style={styles.countText}>
                {shown.toLocaleString()} {clustered ? 'stops in view' : 'stops'}
              </Text>
            )}
          </View>
        </View>

        {/* Scrolls rather than wraps: four chips do not fit on one line on a
            360dp handset, and a second row pushed the map's top edge down. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {ALL_STATUSES.map((status) => {
            const on = selected.has(status);
            return (
              <Pressable
                key={status}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => toggle(status)}
                style={[
                  styles.chip,
                  on && {
                    backgroundColor: STATUS_COLORS[status],
                    borderColor: STATUS_COLORS[status],
                  },
                ]}
              >
                <View
                  style={[
                    styles.chipDot,
                    { backgroundColor: on ? '#FFFFFF' : STATUS_COLORS[status] },
                  ]}
                />
                <Text style={[styles.chipText, on && styles.chipTextOn]}>
                  {STATUS_LABELS[status]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {error ? (
          <View style={styles.notice}>
            <Feather name="alert-circle" size={14} color={colors.alert} />
            <Text style={styles.noticeText}>{error}</Text>
          </View>
        ) : collection.truncated ? (
          <View style={styles.notice}>
            <Feather name="zoom-in" size={14} color={colors.progress} />
            <Text style={styles.noticeText}>Too many stops here to show them all. Zoom in.</Text>
          </View>
        ) : null}
      </View>

      <Text
        style={[
          styles.attribution,
          { bottom: Math.max(insets.bottom, spacing.sm), left: insets.left + spacing.md },
        ]}
      >
        {ATTRIBUTION}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.page },
  map: { flex: 1 },

  overlay: { position: 'absolute', gap: spacing.sm },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  floatingButton: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    ...shadow.raised,
  },
  countPill: {
    minWidth: 96,
    paddingHorizontal: spacing.sm + 2,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.background,
    ...shadow.raised,
  },
  countText: { fontSize: 13, fontWeight: '600', color: colors.text },

  chips: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: spacing.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm + 2,
    height: 34,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    ...shadow.card,
  },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.text },
  chipTextOn: { color: '#FFFFFF' },

  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
    borderRadius: radius.lg,
    backgroundColor: colors.background,
    ...shadow.card,
  },
  noticeText: { fontSize: 12, fontWeight: '500', color: colors.text },

  attribution: {
    position: 'absolute',
    fontSize: 11,
    color: colors.textMuted,
    backgroundColor: 'rgba(255,255,255,0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
});
