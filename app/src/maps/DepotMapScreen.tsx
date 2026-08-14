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
import { RenderMode, runCameraTour } from './perf-harness';
import { getTodayStops, type StopWithSync } from '../db/stops-repo';
import { Button, colors, radius, shadow, spacing, type } from '../ui/components';
import { navigateTo } from './navigate-to';
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
import type { PressEventWithFeatures, ViewStateChangeEvent } from '@maplibre/maplibre-react-native';

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

interface SelectedPin {
  id: string;
  lat: number;
  lng: number;
  status: StatusCode;
  /** Non-null only when this stop is on the signed-in driver's own round. */
  mine: StopWithSync | null;
}

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
export function DepotMapScreen({
  onBack,
  onOpenStop,
}: {
  onBack: () => void;
  onOpenStop: (stopId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<DepotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<StatusCode>>(new Set(ALL_STATUSES));
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);
  const [pin, setPin] = useState<SelectedPin | null>(null);

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewport = useRef<{ bbox: string; zoom: number } | null>(null);
  // Rising id: a slow response for an old viewport must never overwrite a
  // newer one that already arrived.
  const requestId = useRef(0);

  /**
   * The before-and-after switch for the depot map's performance claim.
   *
   * `legacy` is what this screen did first: ask for every stop the depot owns,
   * once, and let the client cluster 5,000 features itself. `viewport` is what
   * it does now: send the rectangle and the zoom, and let Postgres aggregate.
   * Both live in the shipped build so the comparison can be re-run on the same
   * binary, on the same handset, against the same data, rather than quoted
   * from two builds that differed in other ways too.
   */
  const [legacy, setLegacy] = useState(false);
  const [touring, setTouring] = useState(false);

  const load = useCallback(async (bbox: string, zoom: number, statuses: Set<StatusCode>) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      // Omitting bbox and zoom is the server's "give me the working set"
      // contract, which is exactly the old behaviour.
      const params = legacy
        ? new URLSearchParams()
        : new URLSearchParams({ bbox, zoom: zoom.toFixed(2) });
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
  }, [legacy]);

  /**
   * The first viewport is not a gesture, so nothing would request it. Read the
   * bounds off the map once it is ready rather than assuming what they are
   * from the initial centre and zoom, which ignores the screen's aspect.
   */
  const onDidFinishLoadingMap = useCallback(() => {
    void (async () => {
      const map = mapRef.current;
      if (!map) return;

      // Nothing recentres this map on the device.
      //
      // It used to fly to the driver's position once the map was ready, which
      // was wrong twice over. The coverage is wherever the depot works, not
      // wherever the driver happens to be standing, so a driver away from the
      // area opened on an empty screen. And the move was not as "once" as it
      // looked: anything that reloaded the map ran it again, so tapping a
      // cluster threw the camera back across the world mid-gesture.
      //
      // The camera is now framed from the coverage itself, below, and after
      // that it only moves when someone drags it.
      const [bounds, zoom] = await Promise.all([map.getBounds(), map.getZoom()]);
      const [west, south, east, north] = bounds;
      viewport.current = { bbox: `${west},${south},${east},${north}`, zoom };

      // The first request deliberately ignores that rectangle and asks for the
      // whole world at cluster zoom.
      //
      // Fitting to a viewport-bounded response only ever re-frames what was
      // already on screen, so the map settled on whichever corner of the
      // coverage it happened to open over. Asking wide costs one small response
      // because the server aggregates at this zoom, and it is what lets the
      // effect below frame the real coverage without the app knowing in advance
      // which country the depot operates in. Every request after this one is
      // viewport-bounded as normal.
      await load('-180,-85,180,85', 2, selected);
    })();
  }, [load, selected]);

  /**
   * Frame the coverage, once, from what the first response actually contained.
   *
   * A fixed opening zoom cannot do this. Centred on the driver it puts them in
   * the middle of the view, which for a coastal depot spends half the screen on
   * sea while the far end of the coverage sits off the top edge. The stops
   * themselves are the only thing that knows how big the area is, so the first
   * clustered response gets to decide, and this never runs again: refitting
   * later would fight the driver every time they panned.
   */
  const fittedToCoverage = useRef(false);
  useEffect(() => {
    if (fittedToCoverage.current || !data || data.features.length < 2) return;
    fittedToCoverage.current = true;

    let west = 180, south = 90, east = -180, north = -90;
    for (const f of data.features) {
      const [lng, lat] = f.geometry.coordinates;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    if (west > east || south > north) return;

    cameraRef.current?.fitBounds([west, south, east, north], {
      // Extra room at the top: the status filter chips and the count badge
      // float over the map there, and a cluster tucked under them looks like a
      // cluster that is missing.
      padding: { top: 130, right: 40, bottom: 60, left: 40 },
      // No animation. This is where the map should have opened.
      duration: 0,
    });
  }, [data]);

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

  /**
   * A cell zooms in; a stop opens its detail.
   *
   * Which stop detail a driver may see is decided here, without asking the
   * server anything: the round already lives in SQLite, so a stop that matches
   * one of ours resolves to a full address offline. Anything else belongs to
   * another driver's round and stays what the map payload already said it was,
   * a coordinate and a status. That keeps the promise the payload makes, which
   * is that this screen shows the shape of the day and never becomes a
   * directory of who is delivering where.
   */
  const onPress = useCallback(
    async (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
      const feature = event.nativeEvent.features[0];
      if (!feature) return;
      const props = feature.properties as { id?: string; s?: StatusCode; point_count?: number };
      const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;

      if (props.point_count !== undefined) {
        const zoom = viewport.current?.zoom ?? DEPOT_ZOOM;
        cameraRef.current?.easeTo({ center: [lng, lat], zoom: Math.min(zoom + 2, 16), duration: 400 });
        return;
      }
      if (!props.id) return;

      const mine = (await getTodayStops()).find((s) => s.stop_id === props.id) ?? null;
      setPin({ id: props.id, lat, lng, status: props.s ?? StatusCode.Pending, mine });
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
        <GeoJSONSource id="depot" data={collection as never} cluster={false} onPress={onPress}>
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
          {/* Invisible, wider circle under the visible one: a 5dp dot is far
              below a fingertip, and hit testing uses the painted radius. */}
          <Layer
            id="depot-stops-touch"
            type="circle"
            filter={['!', ['has', 'point_count']] as never}
            paint={{ 'circle-color': '#000000', 'circle-opacity': 0, 'circle-radius': 14 }}
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
          {/* Perf comparison controls. Both modes ship so the numbers can be
              re-run on the same binary rather than quoted from two builds. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={legacy ? 'Perf mode: all stops' : 'Perf mode: viewport'}
            onPress={() => setLegacy((v) => !v)}
            style={styles.floatingButton}
          >
            <Feather name={legacy ? 'layers' : 'crop'} size={18} color={colors.text} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Run camera tour"
            onPress={() => {
              if (touring) return;
              setTouring(true);
              void runCameraTour(
                cameraRef.current,
                (statuses) => setSelected(new Set(statuses)),
                legacy ? RenderMode.Legacy : RenderMode.Viewport,
              ).finally(() => setTouring(false));
            }}
            style={styles.floatingButton}
          >
            <Feather name={touring ? 'loader' : 'play'} size={18} color={colors.text} />
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

      {pin ? (
        <View
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, spacing.md),
              left: insets.left + spacing.md,
              right: insets.right + spacing.md,
            },
          ]}
        >
          <View style={styles.sheetHead}>
            <View style={[styles.sheetDot, { backgroundColor: STATUS_COLORS[pin.status] }]} />
            <View style={styles.sheetText}>
              <Text style={type.bodyStrong} numberOfLines={2}>
                {pin.mine ? pin.mine.address : STATUS_LABELS[pin.status]}
              </Text>
              <Text style={type.meta}>
                {pin.mine
                  ? `${pin.mine.postcode}  ·  your stop ${pin.mine.seq}`
                  : 'On another driver’s round'}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={10}
              onPress={() => setPin(null)}
            >
              <Feather name="x" size={20} color={colors.textMuted} />
            </Pressable>
          </View>

          <View style={styles.sheetActions}>
            <View style={styles.sheetAction}>
              <Button
                label="Navigate"
                icon="corner-up-right"
                variant={pin.mine ? 'primary' : 'secondary'}
                onPress={() => void navigateTo(pin.lat, pin.lng, pin.mine?.address)}
              />
            </View>
            {pin.mine ? (
              <View style={styles.sheetAction}>
                <Button
                  label="Open stop"
                  icon="clipboard"
                  variant="secondary"
                  onPress={() => onOpenStop(pin.id)}
                />
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

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

  sheet: {
    position: 'absolute',
    bottom: 0,
    marginBottom: spacing.lg,
    padding: spacing.md,
    gap: spacing.md,
    borderRadius: radius.xl,
    backgroundColor: colors.background,
    ...shadow.raised,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sheetDot: { width: 12, height: 12, borderRadius: 6 },
  sheetText: { flex: 1, gap: 2 },
  sheetActions: { flexDirection: 'row', gap: spacing.sm },
  sheetAction: { flex: 1 },

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
