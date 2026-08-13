import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOUCH_TARGET } from '../ui/theme';
import { planScrollRestore } from './scroll-restore';

/** Input's minHeight in ui/components. The filter button matches it exactly. */
const INPUT_HEIGHT = 54;
import {
  Banner,
  Card,
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
  shadow,
  spacing,
  type,
} from '../ui/components';
import { attemptBadge, secondsUntilRetry, syncBanner, type BannerState } from '../sync/badges';
import { displayStopStatus } from '../domain/outcomes';
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
import { getSessionState, SessionState, signOut } from '../auth/session';
import { planSignOut } from './sign-out';
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
 * Placeholder rows for the only case that warrants them: nothing to show yet.
 *
 * A skeleton stands in for content that is coming. Once the round is on the
 * phone there is real content, and swapping 151 known stops for grey bars on
 * every pull would be worse than the spinner alone: the driver pulled to
 * refresh while looking at something, and taking it away mid-read answers a
 * question they were not asking.
 */
function StopListSkeleton() {
  return (
    <View style={styles.skeletonList}>
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <Card key={row}>
          <View style={styles.row}>
            <View style={[styles.seq, styles.skeletonBlock]} />
            <View style={styles.details}>
              <View style={[styles.skeletonBlock, styles.skeletonLineWide]} />
              <View style={[styles.skeletonBlock, styles.skeletonLineNarrow]} />
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

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
    const complete = DONE_STATUSES.has(displayStopStatus(item.status, item.latest_local_outcome));
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
    a.item.next_retry_at === b.item.next_retry_at &&
    // Drives the done tick while offline. Omitting it would memoize the row
    // into showing pending for a delivery the driver had already recorded.
    a.item.latest_local_outcome === b.item.latest_local_outcome,
);

export function StopListScreen({
  onOpenStop,
  onOpenMap,
  onSignedOut,
}: {
  onOpenStop: (stopId: string) => void;
  onOpenMap: () => void;
  onSignedOut: () => void;
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
  const [offlineNote, setOfflineNote] = useState(false);
  // First load only. Replacing a full round with placeholders on every pull
  // would take away the data the driver is using to answer a question they
  // already had; a skeleton is for when there is genuinely nothing to show.
  const [everLoaded, setEverLoaded] = useState(false);
  const [filter, setFilter] = useState<StopFilter>(StopFilter.All);
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  // Measured rather than guessed, so the menu hangs off the row wherever the
  // header ends up on a given handset.
  const [menuTop, setMenuTop] = useState(0);

  const narrow = useCallback((next: StopFilter | null, text: string | null) => {
    // A remembered offset belongs to the list it was measured on.
    rememberedOffset = 0;
    targetOffset.current = 0;
    restoreAttempts.current = 0;
    restored.current = true;
    if (next !== null) setFilter(next);
    if (text !== null) setQuery(text);
  }, []);
  const online = syncEngine.isOnline();
  const listRef = useRef<FlatList<StopWithSync>>(null);
  const restored = useRef(false);
  const restoreAttempts = useRef(0);
  /**
   * The position to climb back to, captured once at mount.
   *
   * It cannot be read from `rememberedOffset` during the climb: every
   * programmatic scroll fires onScroll, which writes the current position back
   * into `rememberedOffset`. The ladder was overwriting its own target on each
   * step and converging on wherever it had got to, which on a virtualised list
   * is the top. So the target is frozen here and live tracking is suspended
   * until the climb finishes.
   */
  const targetOffset = useRef(rememberedOffset);

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
    setEverLoaded(true);
    const counts = await syncCounts();
    const needsReauth = (await getSessionState()) === SessionState.NeedsReauth;
    setBanner(syncBanner(counts, syncEngine.isOnline(), needsReauth));
  }, []);

  useEffect(() => {
    void load();
    return syncEngine.subscribe(() => void load());
  }, [load]);

  // Counts are read fresh rather than from the banner: the driver is about to
  // make a decision based on this number, so it should not be a render or two
  // out of date.
  const onSignOut = useCallback(() => {
    void (async () => {
      const plan = planSignOut(await syncCounts());
      Alert.alert(plan.title, plan.message, [
        { text: 'Stay signed in', style: 'cancel' },
        {
          text: plan.confirmLabel,
          style: plan.hasUnsentWork ? 'destructive' : 'default',
          onPress: () => {
            void (async () => {
              await signOut();
              onSignedOut();
            })();
          },
        },
      ]);
    })();
  }, [onSignedOut]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setOfflineNote(false);
    try {
      if (syncEngine.isOnline()) {
        // Pull-to-sync means exactly that: fetch the route AND push evidence.
        await refreshTodayStops().catch(() => undefined);
        await syncEngine.kick();
      } else {
        // Offline is not an error and must not read like one. The round is
        // already on this phone, so a pull re-reads it and says plainly that
        // nothing was fetched, rather than spinning at a network that is not
        // there or blanking the list the driver is working from.
        setOfflineNote(true);
      }
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const done = stops.filter((s) =>
    DONE_STATUSES.has(displayStopStatus(s.status, s.latest_local_outcome)),
  ).length;

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
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open maps"
              onPress={onOpenMap}
              style={({ pressed }) => [
                styles.mapButton,
                pressed && { backgroundColor: colors.input },
              ]}
            >
              <Feather name="map" size={20} color={colors.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              onPress={onSignOut}
              style={({ pressed }) => [
                styles.mapButton,
                pressed && { backgroundColor: colors.input },
              ]}
            >
              <Feather name="log-out" size={20} color={colors.text} />
            </Pressable>
          </View>
        }
      />

      {banner.visible ? <Banner label={banner.label} tone={banner.tone} /> : null}
      {offlineNote ? (
        <Banner label="No signal. Showing the round saved on this phone." tone="neutral" />
      ) : null}

      {/* Filter lives in the search row, not in a band of pills below it.
          A row of chips cost a permanent strip of vertical space on a screen
          whose entire job is showing as many stops as possible, and it grew
          with every filter added. */}
      <View
        style={[styles.searchRow, edge]}
        onLayout={(event) => {
          const { y, height } = event.nativeEvent.layout;
          setMenuTop(y + height);
        }}
      >
        <View style={styles.searchField}>
          <Input
            value={query}
            onChangeText={(text) => narrow(null, text)}
            placeholder="Search address or postcode"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Filter: ${STOP_FILTER_LABELS[filter]}`}
          onPress={() => setMenuOpen(true)}
          style={[styles.filterButton, filter !== StopFilter.All && styles.filterButtonActive]}
        >
          <Feather
            name="filter"
            size={20}
            color={filter === StopFilter.All ? colors.textMuted : colors.primary}
          />
        </Pressable>
      </View>

      {/* An active filter has to be legible without opening the menu: a funnel
          icon alone does not say what is being hidden, and a driver who cannot
          see that 148 stops are filtered out will think the round is finished. */}
      {filter !== StopFilter.All ? (
        <Pressable style={[styles.activeFilter, edge]} onPress={() => narrow(StopFilter.All, null)}>
          <Text style={styles.activeFilterText}>
            {STOP_FILTER_LABELS[filter]}  ·  {filterCounts[filter]} of {stops.length}
          </Text>
          <Feather name="x" size={14} color={colors.primary} />
        </Pressable>
      ) : null}

      {menuOpen ? (
        <Modal transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
          {/* The backdrop is the dismiss target, so a tap anywhere outside
              closes it rather than trapping the driver in a menu. */}
          <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
            {/* onLayout reports y relative to Screen, and Screen is
                full-bleed from the top of the window, so that y already
                includes the status bar. Adding insets.top on top of it pushed
                the menu a status bar's height too far down. Right-aligned
                because the button it belongs to is now on the right. */}
            <View
              style={[
                styles.menuPanel,
                { top: menuTop + spacing.xs, right: insets.right + spacing.md },
              ]}
            >
              {STOP_FILTER_ORDER.map((option) => {
                const selected = option === filter;
                return (
                  <Pressable
                    key={option}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      narrow(option, null);
                      setMenuOpen(false);
                    }}
                    style={({ pressed }) => [
                      styles.menuItem,
                      pressed && { backgroundColor: colors.secondary },
                    ]}
                  >
                    <Feather
                      name={selected ? 'check' : 'chevron-right'}
                      size={16}
                      color={selected ? colors.primary : colors.textSubtle}
                    />
                    <Text style={[styles.menuLabel, selected && styles.menuLabelSelected]}>
                      {STOP_FILTER_LABELS[option]}
                    </Text>
                    <Text style={styles.menuCount}>{filterCounts[option]}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Modal>
      ) : null}

      <FlatList
        ref={listRef}
        data={visible}
        onScroll={(event) => {
          // Ignored while restoring, or the climb overwrites its own target.
          if (!restored.current) return;
          rememberedOffset = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={64}
        onContentSizeChange={(_width, height) => {
          // The decision lives in scroll-restore.ts, where a test drives the
          // whole virtualised growth loop and asserts where it lands. This was
          // shipped wrong twice on reasoning alone; it is not reasoned about
          // here any more.
          if (restored.current) return;

          const action = planScrollRestore({
            target: targetOffset.current,
            contentHeight: height,
            attempts: restoreAttempts.current,
          });

          if (action.kind === 'done') {
            restored.current = true;
            return;
          }

          if (action.kind === 'settle') {
            listRef.current?.scrollToOffset({ offset: action.offset, animated: false });
            // Marked done after the scroll, so the onScroll it triggers is
            // still suppressed and cannot clobber the position just taken.
            restored.current = true;
            rememberedOffset = action.offset;
            return;
          }

          restoreAttempts.current += 1;
          listRef.current?.scrollToOffset({ offset: action.offset, animated: false });
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
          !everLoaded || (refreshing && stops.length === 0) ? (
            <StopListSkeleton />
          ) : filter !== StopFilter.All ? (
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
  headerActions: { flexDirection: 'row', gap: spacing.xs },
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
  skeletonList: { gap: spacing.sm },
  skeletonBlock: { backgroundColor: colors.secondary, borderRadius: radius.sm },
  skeletonLineWide: { height: 15, width: '72%' },
  skeletonLineNarrow: { height: 12, width: '40%', marginTop: 6 },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  searchField: { flex: 1 },
  filterButton: {
    // Square, and exactly the Input's minHeight (54) so the two sit on one
    // line with no visual step between them.
    width: INPUT_HEIGHT,
    height: INPUT_HEIGHT,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterButtonActive: { borderColor: colors.primary, backgroundColor: colors.background },

  activeFilter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  activeFilterText: { color: colors.primary, fontSize: 13, fontWeight: '700' },

  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  menuPanel: {
    position: 'absolute',
    minWidth: 240,
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    ...shadow.card,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: TOUCH_TARGET,
  },
  menuLabel: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  menuLabelSelected: { color: colors.primary },
  menuCount: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  rowWithdrawn: { opacity: 0.45 },
  badgeRow: { marginTop: 6 },
});
