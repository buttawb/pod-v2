import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  Banner,
  BottomBar,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Screen,
  SectionLabel,
  SyncBadge,
  useEdgePadding,
  CONTENT_MAX_WIDTH,
  colors,
  radius,
  spacing,
  type,
} from '../ui/components';
import { attemptBadge, secondsUntilRetry } from '../sync/badges';
import { useAttemptDetails, type RemoteAttempt } from '../ui/AttemptDetailsModal';
import { getStop, type StopRow } from '../db/stops-repo';
import { getDatabase } from '../db/schema';
import { apiRequest } from '../api/client';
import { getDraftForStop, getPhotos, retryNow } from '../db/attempts-repo';
import { isSubstantiveDraft } from '../sync/drafts';
import { getSession } from '../auth/session';
import { syncEngine } from '../sync/sync-engine';
import { SyncState } from '../sync/state-machine';
import { OUTCOME_SPECS, type Outcome } from '../domain/outcomes';
import { gateLevel, GateLevel, useVersionGate } from '../version/version-gate';

interface AttemptSummary {
  client_attempt_id: string;
  attempt_no: number;
  outcome: Outcome | null;
  captured_at: string;
  sync_state: SyncState;
  last_error_message: string | null;
  next_retry_at: string | null;
  confirmed: number;
  total: number;
  /** Set when this row came from the server rather than this device's queue. */
  remote?: RemoteAttempt;
}

/** The shape GET /api/v2/stops/{id} returns for each attempt. */
interface ServerAttempt {
  clientAttemptId: string;
  outcome: Outcome | null;
  capturedAt: string;
  receivedAt?: string;
  note?: string | null;
  reasonCode?: string | null;
  evidenceStatus?: string;
  photos?: Array<{ index: number; status: string }>;
}

export function StopDetailScreen({
  stopId,
  onCapture,
  onBack,
}: {
  stopId: string;
  onCapture: () => void;
  onBack: () => void;
}) {
  const edge = useEdgePadding();
  const [stop, setStop] = useState<StopRow | null>(null);
  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [hasDraft, setHasDraft] = useState(false);
  const details = useAttemptDetails();
  const gate = useVersionGate();

  const load = useCallback(async () => {
    setStop(await getStop(stopId));

    const local = await getDatabase().getAllAsync<AttemptSummary>(
      `SELECT a.client_attempt_id, a.attempt_no, a.outcome, a.captured_at, a.sync_state,
              a.last_error_message, a.next_retry_at,
              (SELECT count(*) FROM attempt_photos p
                WHERE p.client_attempt_id = a.client_attempt_id AND p.upload_state = 'confirmed') AS confirmed,
              (SELECT count(*) FROM attempt_photos p
                WHERE p.client_attempt_id = a.client_attempt_id) AS total
       FROM attempts a
       WHERE a.stop_id = ? AND a.sync_state <> 'draft'
       ORDER BY a.attempt_no DESC`,
      stopId,
    );
    setAttempts(local);

    /**
     * Then ask the server what it holds for this stop, and merge.
     *
     * This list used to be local rows only, which is wrong the moment the same
     * driver is signed in on a second handset, or picks up a spare mid-shift.
     * An attempt captured on the other phone lives on the server and nowhere on
     * this one, so the history read empty here while the stop itself showed as
     * delivered: the list status comes from the server on every route refresh,
     * the attempts did not.
     *
     * Local wins on conflict, deliberately. A row this device is still holding
     * knows things the server cannot: that it is queued, retrying, or parked
     * with an error. The server copy of the same attempt would overwrite that
     * with a flat "synced" and hide work still in flight.
     *
     * Offline is not a failure. The catch leaves the local list exactly as it
     * was, which is the whole offline promise.
     */
    if (!syncEngine.isOnline()) return;
    try {
      const detail = await apiRequest<{ attempts?: ServerAttempt[] }>(
        `/api/v2/stops/${stopId}`,
      );
      const known = new Set(local.map((a) => a.client_attempt_id));
      const remote: AttemptSummary[] = (detail.attempts ?? [])
        .filter((a) => a.clientAttemptId && !known.has(a.clientAttemptId))
        .map((a, i) => ({
          client_attempt_id: a.clientAttemptId,
          // Numbered below the local ones so the ordering below stays stable;
          // the server does not expose this device's attempt_no sequence.
          attempt_no: -(i + 1),
          outcome: a.outcome,
          captured_at: a.capturedAt,
          sync_state: SyncState.Synced,
          last_error_message: null,
          next_retry_at: null,
          confirmed: (a.photos ?? []).filter((p) => p.status === 'verified').length,
          total: (a.photos ?? []).length,
          remote: {
            outcome: a.outcome,
            capturedAt: a.capturedAt,
            receivedAt: a.receivedAt,
            note: a.note ?? null,
            reasonCode: a.reasonCode ?? null,
            evidenceStatus: a.evidenceStatus,
            photoCount: (a.photos ?? []).length,
          },
        }));
      if (remote.length === 0) return;
      setAttempts(
        [...local, ...remote].sort(
          (x, y) => Date.parse(y.captured_at) - Date.parse(x.captured_at),
        ),
      );
    } catch {
      // Keep what is on the device.
    }

    const session = await getSession();
    const draft = session ? await getDraftForStop(stopId, session.driverId) : null;
    setHasDraft(
      draft ? isSubstantiveDraft(draft, await getPhotos(draft.client_attempt_id)) : false,
    );
  }, [stopId]);

  useEffect(() => {
    void load();
    return syncEngine.subscribe(() => void load());
  }, [load]);

  // A countdown that does not count down is worse than no countdown: it reads
  // as a stalled attempt. The ticker runs only while something is actually
  // waiting, so an idle stop costs nothing.
  const [, setTick] = useState(0);
  const waiting = attempts.some((a) => secondsUntilRetry(a.next_retry_at) !== null);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const captureBlocked = gateLevel(gate) === GateLevel.Blocked;

  return (
    <Screen>
      <PageHeader title={stop?.address ?? 'Stop'} subtitle={stop?.postcode} onBack={onBack} />

      {stop?.removed === 1 ? (
        <Banner
          label="Removed by dispatch. Evidence you already captured still uploads."
          tone="progress"
        />
      ) : null}

      {hasDraft ? (
        <Banner label="You have an unfinished attempt at this stop." tone="progress" />
      ) : null}

      <ScrollView contentContainerStyle={[styles.content, edge]}>
        <Card style={styles.locationCard}>
          <View style={styles.locationRow}>
            <View style={styles.pin}>
              <Feather name="map-pin" size={18} color={colors.text} />
            </View>
            <View style={styles.locationText}>
              <Text style={type.bodyStrong}>{stop?.address ?? '-'}</Text>
              <Text style={type.meta}>
                {stop?.postcode}
                {stop ? `  ·  Stop ${stop.seq}` : ''}
              </Text>
            </View>
          </View>
        </Card>

        <SectionLabel>
          Attempts{attempts.length > 0 ? ` (${attempts.length})` : ''}
        </SectionLabel>

        {attempts.length === 0 ? (
          <Card>
            <EmptyState
              icon="clipboard"
              title="No attempts yet"
              body="Record what happened at this stop and it is saved to this phone straight away."
            />
          </Card>
        ) : (
          attempts.map((attempt) => (
            <Card
              key={attempt.client_attempt_id}
              style={styles.attemptCard}
              // A row captured on another handset opens the same sheet, given
              // what the server returned rather than a local lookup that would
              // find nothing. Reading it locally is what produced "this attempt
              // is no longer on this device" about a row on the screen behind
              // it: true, and useless, because nothing was lost.
              onPress={() => details.open(attempt.client_attempt_id, attempt.remote)}
            >
              <View style={styles.attemptRow}>
                <View style={styles.attemptDetails}>
                  <Text style={type.bodyStrong}>
                    {attempt.outcome ? OUTCOME_SPECS[attempt.outcome].label : 'Unknown'}
                  </Text>
                  <Text style={type.meta}>
                    {attempt.remote
                      ? `Captured on another device  ·  ${formatTime(attempt.captured_at)}`
                      : `Attempt ${attempt.attempt_no}  ·  ${formatTime(attempt.captured_at)}`}
                  </Text>
                </View>
                <SyncBadge
                  badge={attemptBadge(
                    attempt.sync_state,
                    { confirmed: attempt.confirmed, total: attempt.total },
                    syncEngine.isOnline(),
                    secondsUntilRetry(attempt.next_retry_at),
                  )}
                />
              </View>

              {attempt.sync_state === SyncState.NeedsAttention ? (
                <View style={styles.errorBlock}>
                  <Text style={styles.errorText}>
                    {attempt.last_error_message ?? 'Could not reach the server'}
                  </Text>
                  <Text style={type.meta}>Everything is still saved on this phone.</Text>
                  <View style={styles.retry}>
                    <Button
                      label="Retry now"
                      icon="refresh-cw"
                      variant="secondary"
                      onPress={() => {
                        void retryNow(attempt.client_attempt_id).then(() => syncEngine.kick());
                      }}
                    />
                  </View>
                </View>
              ) : null}
            </Card>
          ))
        )}
      </ScrollView>

      <BottomBar>
        {captureBlocked ? (
          <View style={styles.blocked}>
            <Feather name="alert-circle" size={16} color={colors.alert} />
            <Text style={styles.blockedText}>
              Update required before recording new attempts. Uploads still work.
            </Text>
          </View>
        ) : null}
        <Button
          label={hasDraft ? 'Resume attempt' : 'Record attempt'}
          icon={hasDraft ? 'edit-3' : 'plus'}
          onPress={onCapture}
          disabled={captureBlocked}
        />
      </BottomBar>
    </Screen>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${date.toLocaleTimeString(
    [],
    { hour: '2-digit', minute: '2-digit' },
  )}`;
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  locationCard: { marginBottom: spacing.sm },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  pin: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationText: { flex: 1, gap: 2 },
  attemptCard: { gap: spacing.sm },
  attemptRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  attemptDetails: { flex: 1, gap: 2 },
  errorBlock: {
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  errorText: { color: colors.alert, fontSize: 14, fontWeight: '600' },
  retry: { marginTop: spacing.sm },
  blocked: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  blockedText: { flex: 1, color: colors.alert, fontSize: 13, fontWeight: '600' },
});
