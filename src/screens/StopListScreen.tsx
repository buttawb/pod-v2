import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Banner, Card, Screen, SyncBadge, colors, spacing, type } from '../ui/components';
import { attemptBadge, syncBanner, worstState, type BannerState } from '../sync/badges';
import { syncCounts } from '../db/attempts-repo';
import { getTodayStops, refreshTodayStops, type StopWithSync } from '../db/stops-repo';
import { getSessionState, SessionState } from '../auth/session';
import { syncEngine } from '../sync/sync-engine';
import { SyncState } from '../sync/state-machine';

export function StopListScreen({
  onOpenStop,
  onOpenMap,
}: {
  onOpenStop: (stopId: string) => void;
  onOpenMap: () => void;
}) {
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

  const done = stops.filter((s) => s.status === 'delivered' || s.status === 'failed').length;

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={type.title}>Today</Text>
        <Text style={type.small}>
          {done} of {stops.length} done
        </Text>
      </View>

      {banner.visible ? <Banner label={banner.label} tone={banner.tone} /> : null}

      <FlatList
        data={stops}
        keyExtractor={(item) => item.stop_id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
        ListHeaderComponent={
          <Card onPress={onOpenMap}>
            <Text style={type.bodyStrong}>Maps</Text>
            <Text style={type.small}>My route and depot overview</Text>
          </Card>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={type.body}>No stops loaded yet.</Text>
            <Text style={type.small}>Pull down to fetch today&apos;s route.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const state = (item.worst_sync_state as SyncState | null) ?? null;
          return (
            <Card onPress={() => onOpenStop(item.stop_id)}>
              <View style={styles.row}>
                <Text style={styles.seq}>{item.seq}</Text>
                <View style={styles.details}>
                  <Text style={type.bodyStrong} numberOfLines={1}>
                    {item.address}
                  </Text>
                  <Text style={type.small}>
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
                </View>
                <Text style={styles.chevron}>›</Text>
              </View>
            </Card>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  seq: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textMuted,
    minWidth: 34,
    textAlign: 'center',
  },
  details: { flex: 1, gap: 2 },
  badgeRow: { marginTop: 6 },
  chevron: { fontSize: 28, color: colors.textMuted },
  empty: { padding: spacing.xl, gap: spacing.xs, alignItems: 'center' },
});
