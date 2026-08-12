import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Banner,
  Card,
  Chip,
  EmptyState,
  Input,
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
import { attemptBadge, secondsUntilRetry, syncBanner, type BannerState } from '../sync/badges';
import {
  StopFilter,
  STOP_FILTER_LABELS,
  STOP_FILTER_ORDER,
  countByStopFilter,
  matchesStopFilter,
  matchesStopSearch,
} from '../domain/stop-filters';
import { syncCounts } from '../db/attempts-repo';
import { getTodayStops, refreshTodayStops, type StopWithSync } from '../db/stops-repo';
import { getSessionState, SessionState } from '../auth/session';
import { syncEngine } from '../sync/sync-engine';
import { SyncState } from '../sync/state-machine';

const DONE_STATUSES = new Set(['delivered', 'failed']);

/**
 * Where the driver was in the round, remembered across navigation.
 *
 * Opening stop 96 and coming back used to land at the top of the list, so the
 * driver scrolled through ninety-five rows they had already dealt with to get
 * back to where they were standing. The screen unmounts on navigation, so the
 * offset cannot live in its state; it is deliberately module scope rather than
 * something persisted, because it is a position in this session's list, not a
 * fact about the round.
 *
 * Reset whenever the visible set changes: an offset measured against one list
 * means nothing against a shorter filtered one, and restoring it would scroll
 * to an unrelated row.
 */
let rememberedOffset = 0;

/**
 * One stop, memoized.
 *
 * The list re-reads SQLite on every sync notification: a heartbeat tick, a
 * NetInfo edge, an announce() after a route pull. Without memoization each of
 * those re-rendered every mounted row on a 150-stop day, for a change that
 * usually touches one of them. The comparator is explicit rather than a
 * shallow prop check because the row object is a fresh object from SQLite
 * every time, so a default memo would never hit.
 */
interface StopRowProps {
  item: StopWithSync;
  online: boolean;
  onPress: (stopId: string) => void;
}

const StopListRow = memo(
  function StopListRow({ item, online, onPress }: StopRowProps) {
    const state = (item.worst_sync_state as SyncState | null) ?? null;
    const complete = DONE_STATUSES.has(item.status);
    const hasLocalWork = item.attempt_count > 0 || item.has_unfinished_draft === 1;
    // Dispatch pulled the stop after the driver had already worked it. Never
    // greyed and never hidden: that evidence is real and still uploading, and
    // the driver needs to see that the paperwork moved under them.
    const changedAfterAction = item.removed === 1 && hasLocalWork;
    // Pulled before anyone touched it. Nothing was lost, so it recedes.
    const withdrawn = item.removed === 1 && !hasLocalWork;

    return (
      <Card onPress={() => onPress(item.stop_id)}>
        <View style={[styles.row, withdrawn && styles.rowWithdrawn]}>
          <View style={[styles.seq, complete && styles.seqDone]}>
            {complete ? (
              <Feather name="check" size={16} color={colors.good} />
            ) : (
              <Text style={styles.seqText}>{item.seq}</Text>
            )}
          </View>

          <View style={styles.details}>
            <Text style={[type.bodyStrong, complete && styles.addressDone]} numberOfLines={1}>
              {item.address}
            </Text>
            <Text style={type.meta}>
              {item.postcode}
              {withdrawn ? '  ·  removed by office' : ''}
            </Text>

            {changedAfterAction ? (
              <View style={styles.badgeRow}>
                <SyncBadge badge={{ label: 'Changed after action', tone: 'alert' }} />
              </View>
            ) : null}

            {state ? (
              <View style={styles.badgeRow}>
                <SyncBadge
                  badge={attemptBadge(
                    state,
                    { confirmed: item.photos_confirmed, total: item.photos_total },
                    online,
                    secondsUntilRetry(item.next_retry_at),
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
  },
  (a, b) =>
    a.online === b.online &&
    a.onPress === b.onPress &&
    a.item.stop_id === b.item.stop_id &&
    a.item.seq === b.item.seq &&
    a.item.address === b.item.address &&
    a.item.postcode === b.item.postcode &&
    a.item.status === b.item.status &&
    a.item.removed === b.item.removed &&
    a.item.attempt_count === b.item.attempt_count &&
    a.item.worst_sync_state === b.item.worst_sync_state &&
    a.item.has_unfinished_draft === b.item.has_unfinished_draft &&
    a.item.photos_confirmed === b.item.photos_confirmed &&
    a.item.photos_total === b.item.photos_total &&
    a.item.next_retry_at === b.item.next_retry_at,
);

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
  const [filter, setFilter] = useState<StopFilter>(StopFilter.All);
  const [query, setQuery] = useState('');

  const narrow = useCallback((next: StopFilter | null, text: string | null) => {
    // A remembered offset belongs to the list it was measured on.
    rememberedOffset = 0;
    if (next !== null) setFilter(next);
    if (text !== null) setQuery(text);
  }, []);
  const online = syncEngine.isOnline();
  const listRef = useRef<FlatList<StopWithSync>>(null);
  const restored = useRef(false);

  // Counted over the whole day, not the filtered view, so the chips answer
  // "is there anything there" without having to be tapped.
  const filterCounts = useMemo(() => countByStopFilter(stops), [stops]);
  const visible = useMemo(
    () =>
      stops.filter((s) => matchesStopFilter(s, filter) && matchesStopSearch(s, query)),
    [stops, filter, query],
  );

  // Stable identity, so a re-render of the screen does not invalidate every
  // memoized row through a fresh renderItem closure.
  const renderStop = useCallback(
    ({ item }: { item: StopWithSync }) => (
      <StopListRow item={item} online={online} onPress={onOpenStop} />
    ),
    [online, onOpenStop],
  );
  const keyExtractor = useCallback((item: StopWithSync) => item.stop_id, []);

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

      <View style={[styles.search, edge]}>
        <Input
          value={query}
          onChangeText={(text) => narrow(null, text)}
          placeholder="Search address or postcode"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      {/* The round is ordered by sequence, which is the order the van drives
          and the wrong order for "what have I not done". Filtering is local:
          every field these read is already on the row, so it works with no
          signal, which is where a driver most needs to ask the question. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.filters, edge]}
        keyboardShouldPersistTaps="handled"
      >
        {STOP_FILTER_ORDER.map((option) => (
          <Chip
            key={option}
            label={`${STOP_FILTER_LABELS[option]} ${filterCounts[option]}`}
            selected={filter === option}
            onPress={() => narrow(option, null)}
          />
        ))}
      </ScrollView>

      <FlatList
        ref={listRef}
        data={visible}
        onScroll={(event) => {
          rememberedOffset = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          // Restore once, after the rows exist. Scrolling before layout is a
          // no-op, which is why this cannot happen on mount.
          if (restored.current || rememberedOffset <= 0) return;
          restored.current = true;
          listRef.current?.scrollToOffset({ offset: rememberedOffset, animated: false });
        }}
        keyExtractor={keyExtractor}
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
          filter !== StopFilter.All ? (
            <EmptyState
              icon="filter"
              title="Nothing under this filter"
              body="No stop on today's round is in that state right now."
            />
          ) : (
            <EmptyState
              icon="inbox"
              title="No stops loaded yet"
              body="Pull down to fetch today's route. Once loaded it stays on this phone, signal or not."
            />
          )
        }
        renderItem={renderStop}
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
  // A stop dispatch pulled before anyone worked it. Receded, not hidden:
  // the driver should still see it was on the round this morning.
  search: { paddingTop: spacing.sm },
  filters: { gap: spacing.sm, paddingVertical: spacing.sm, alignItems: 'center' },
  rowWithdrawn: { opacity: 0.45 },
  badgeRow: { marginTop: 6 },
});
