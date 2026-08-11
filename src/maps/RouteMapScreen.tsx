import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  NativeUserLocation,
} from '@maplibre/maplibre-react-native';
import type { NativeSyntheticEvent } from 'react-native';
import type { PressEventWithFeatures } from '@maplibre/maplibre-react-native';
import { getTodayStops, type StopWithSync } from '../db/stops-repo';
import { colors, radius, shadow, spacing } from '../ui/components';
import {
  ATTRIBUTION,
  BASEMAP_STYLE_URL,
  DEPOT_CENTER,
  GLYPH_FONT,
  STATUS_COLOR_EXPRESSION,
  STATUS_COLORS,
  STATUS_LABELS,
  StatusCode,
  statusCodeFor,
} from './basemap';

/**
 * The driver's own stops, colour-coded, with their live position.
 *
 * The rule that keeps this smooth while GPS updates: the puck and the
 * camera are rendered natively by MapLibre's location component, so a
 * position tick never crosses into React. Nothing here holds the location
 * in state, so nothing re-renders once per second.
 */
export function RouteMapScreen({
  onOpenStop,
  onBack,
}: {
  onOpenStop: (stopId: string) => void;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [stops, setStops] = useState<StopWithSync[] | null>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    void (async () => setStops(await getTodayStops()))();
  }, []);

  // Built once per stop-list change, never per GPS tick.
  const collection = useMemo(() => {
    const features = (stops ?? [])
      .filter((s) => s.lat !== null && s.lng !== null && s.removed === 0)
      .map((s) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [s.lng as number, s.lat as number] as [number, number],
        },
        properties: { id: s.stop_id, s: statusCodeFor(s.status), q: s.seq },
      }));
    return { type: 'FeatureCollection' as const, features };
  }, [stops]);

  const onPress = useCallback(
    (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
      const id = event.nativeEvent.features[0]?.properties?.id as string | undefined;
      if (id) onOpenStop(id);
    },
    [onOpenStop],
  );

  if (!stops) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Map style={styles.map} mapStyle={BASEMAP_STYLE_URL} attribution logo={false}>
        <Camera
          initialViewState={{
            center: collection.features[0]?.geometry.coordinates ?? DEPOT_CENTER,
            zoom: 13,
          }}
          // Tracking is a native camera mode: position ticks move the map on
          // the UI thread without a single React render.
          trackUserLocation={following ? 'default' : undefined}
          zoom={following ? 15 : undefined}
          onTrackUserLocationChange={(event) => {
            // The driver panned: stop fighting their gesture.
            if (!event.nativeEvent.trackUserLocation) setFollowing(false);
          }}
        />

        {/* Native puck: rendered and animated entirely on the UI thread. */}
        <NativeUserLocation />

        <GeoJSONSource id="route-stops" data={collection} cluster={false} onPress={onPress}>
          <Layer
            id="route-stop-circles"
            type="circle"
            paint={{
              'circle-color': STATUS_COLOR_EXPRESSION as never,
              'circle-radius': 9,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#FFFFFF',
            }}
          />
          <Layer
            id="route-stop-labels"
            type="symbol"
            // Sequence numbers only at street level: at route zoom they would
            // be an unreadable collision-detection bill.
            minzoom={14}
            layout={{
              'text-field': ['to-string', ['get', 'q']] as never,
              'text-font': GLYPH_FONT,
              'text-size': 11,
              'text-allow-overlap': false,
            }}
            paint={{ 'text-color': '#FFFFFF' }}
          />
        </GeoJSONSource>
      </Map>

      <View style={[styles.overlay, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to maps"
          onPress={onBack}
          style={styles.floatingButton}
        >
          <Feather name="chevron-left" size={22} color={colors.text} />
        </Pressable>

        <View style={styles.legend}>
          {(
            [
              StatusCode.Pending,
              StatusCode.Delivered,
              StatusCode.Attempted,
              StatusCode.Failed,
            ] as StatusCode[]
          ).map((status) => (
            <View key={status} style={styles.legendRow}>
              <View style={[styles.dot, { backgroundColor: STATUS_COLORS[status] }]} />
              <Text style={styles.legendText}>{STATUS_LABELS[status]}</Text>
            </View>
          ))}
        </View>
      </View>

      {!following ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setFollowing(true)}
          style={[styles.recentre, { bottom: Math.max(insets.bottom, spacing.md) + spacing.lg }]}
        >
          <Feather name="navigation" size={18} color={colors.primaryText} />
          <Text style={styles.recentreText}>Follow my position</Text>
        </Pressable>
      ) : null}

      <Text style={[styles.attribution, { bottom: Math.max(insets.bottom, spacing.sm) }]}>
        {ATTRIBUTION}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.page },
  map: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  overlay: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  floatingButton: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    ...shadow.raised,
  },
  legend: {
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    gap: 5,
    ...shadow.raised,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  legendText: { fontSize: 12, fontWeight: '500', color: colors.text },

  recentre: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    paddingHorizontal: spacing.md + 2,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    ...shadow.raised,
  },
  recentreText: { fontSize: 15, fontWeight: '600', color: colors.primaryText },

  attribution: {
    position: 'absolute',
    left: spacing.md,
    fontSize: 11,
    color: colors.textMuted,
    backgroundColor: 'rgba(255,255,255,0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
});
