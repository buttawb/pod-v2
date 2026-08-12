import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Banner,
  Card,
  EmptyState,
  PageHeader,
  ProgressBar,
  Screen,
  useEdgePadding,
  CONTENT_MAX_WIDTH,
  SyncBadge,
  colors,
  radius,
  spacing,
  type,
} from '../ui/components';
import { attemptBadge, syncBanner, worstState, type BannerState } from '../sync/badges';
import { syncCounts } from '../db/attempts-repo';
import { getTodayStops, refreshTodayStops, type StopWithSync } from '../db/stops-repo';
import { getSessionState, SessionState } from '../auth/session';
import { syncEngine } from '../sync/sync-engine';
import { SyncState } from '../sync/state-machine';

const DONE_STATUSES = new Set(['delivered', 'failed']);

export function StopListScreen({
  onOpenStop,
  onOpenMap,
}: {
  onOpenStop: (stopId: string) => void;
  onOpenMap: () => void;
}) {
  const insets = useSafeAreaInsets();
  const edge = useEdgePadding();
  const [stops, setStops] = useState<StopWithSync[]>([]);
  const [banner, setBanner] = useState<BannerState>({
    label: '',
    tone: 'neutral',
    visible: false,
  });
  const [refreshing, setRefreshing] = useState(false);

  // Everything renders from SQLite; the network only ever updates the cache.
  const load = useCallback(async () => {
    setStops(await getTodayStops());
    const counts = await syncCounts();
    const needsReauth = (await getSessionState()) === SessionState.NeedsReauth;
    setBanner(syncBanner(counts, syncEngine.isOnline(), needsReauth));
  }, []);

  useEffect(() => {
    void load();
    return syncEngine.subscribe(() => void load());
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Pull-to-sync means exactly that: fetch the route AND push evidence.
      await refreshTodayStops().catch(() => undefined);
      await syncEngine.kick();
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const done = stops.filter((s) => DONE_STATUSES.has(s.status)).length;

  return (
    <Screen>
      <PageHeader
        title="Today"
        subtitle={new Date().toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open maps"
            onPress={onOpenMap}
            style={({ pressed }) => [styles.mapButton, pressed && { backgroundColor: colors.input }]}
          >
            <Feather name="map" size={20} color={colors.text} />
          </Pressable>
        }
      />

      {banner.visible ? <Banner label={banner.label} tone={banner.tone} /> : null}

      <FlatList
        data={stops}
        keyExtractor={(item) => item.stop_id}
        contentContainerStyle={[styles.list, edge, { paddingBottom: insets.bottom + spacing.xl }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
        ListHeaderComponent={
          stops.length > 0 ? (
            <Card style={styles.summary}>
              <View style={styles.summaryRow}>
                <Text style={type.subheading}>
                  {done} of {stops.length} done
                </Text>
                <Text style={type.meta}>{stops.length - done} left</Text>
              </View>
              <ProgressBar value={done} total={stops.length} />
            </Card>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            icon="inbox"
            title="No stops loaded yet"
            body="Pull down to fetch today's route. Once loaded it stays on this phone, signal or not."
          />
        }
        renderItem={({ item }) => {
          const state = (item.worst_sync_state as SyncState | null) ?? null;
          const complete = DONE_STATUSES.has(item.status);
          return (
            <Card onPress={() => onOpenStop(item.stop_id)}>
              <View style={styles.row}>
                <View style={[styles.seq, complete && styles.seqDone]}>
                  {complete ? (
                    <Feather name="check" size={16} color={colors.good} />
                  ) : (
                    <Text style={styles.seqText}>{item.seq}</Text>
                  )}
                </View>

                <View style={styles.details}>
                  <Text
                    style={[type.bodyStrong, complete && styles.addressDone]}
                    numberOfLines={1}
                  >
                    {item.address}
                  </Text>
                  <Text style={type.meta}>
                    {item.postcode}
                    {item.removed === 1 ? '  ·  removed by dispatch' : ''}
                  </Text>
                  {state ? (
                    <View style={styles.badgeRow}>
                      <SyncBadge
                        badge={attemptBadge(
                          worstState([state]) ?? state,
                          { confirmed: 0, total: 0 },
                          syncEngine.isOnline(),
                        )}
                      />
                    </View>
                  ) : null}
                  {item.has_unfinished_draft === 1 ? (
                    <View style={styles.badgeRow}>
                      <SyncBadge badge={{ label: 'Unfinished attempt', tone: 'progress' }} />
                    </View>
                  ) : null}
                </View>

                <Feather name="chevron-right" size={20} color={colors.textSubtle} />
              </View>
            </Card>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  mapButton: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.secondary,
  },
  list: {
    paddingTop: spacing.md,
    gap: spacing.sm,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  summary: { gap: spacing.sm, marginBottom: spacing.xs },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  seq: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seqDone: { backgroundColor: colors.goodSurface },
  seqText: { fontSize: 15, fontWeight: '700', color: colors.textMuted },
  details: { flex: 1, gap: 2 },
  addressDone: { color: colors.textMuted },
  badgeRow: { marginTop: 6 },
});
