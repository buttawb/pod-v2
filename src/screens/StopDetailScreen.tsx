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
  colors,
  radius,
  spacing,
  type,
} from '../ui/components';
import { attemptBadge } from '../sync/badges';
import { getStop, type StopRow } from '../db/stops-repo';
import { getDatabase } from '../db/schema';
import { retryNow } from '../db/attempts-repo';
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
  confirmed: number;
  total: number;
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
  const [stop, setStop] = useState<StopRow | null>(null);
  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const gate = useVersionGate();

  const load = useCallback(async () => {
    setStop(await getStop(stopId));
    setAttempts(
      await getDatabase().getAllAsync<AttemptSummary>(
        `SELECT a.client_attempt_id, a.attempt_no, a.outcome, a.captured_at, a.sync_state,
                a.last_error_message,
                (SELECT count(*) FROM attempt_photos p
                  WHERE p.client_attempt_id = a.client_attempt_id AND p.upload_state = 'confirmed') AS confirmed,
                (SELECT count(*) FROM attempt_photos p
                  WHERE p.client_attempt_id = a.client_attempt_id) AS total
         FROM attempts a
         WHERE a.stop_id = ? AND a.sync_state <> 'draft'
         ORDER BY a.attempt_no DESC`,
        stopId,
      ),
    );
  }, [stopId]);

  useEffect(() => {
    void load();
    return syncEngine.subscribe(() => void load());
  }, [load]);

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

      <ScrollView contentContainerStyle={styles.content}>
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
            <Card key={attempt.client_attempt_id} style={styles.attemptCard}>
              <View style={styles.attemptRow}>
                <View style={styles.attemptDetails}>
                  <Text style={type.bodyStrong}>
                    {attempt.outcome ? OUTCOME_SPECS[attempt.outcome].label : 'Unknown'}
                  </Text>
                  <Text style={type.meta}>
                    Attempt {attempt.attempt_no}  ·  {formatTime(attempt.captured_at)}
                  </Text>
                </View>
                <SyncBadge
                  badge={attemptBadge(
                    attempt.sync_state,
                    { confirmed: attempt.confirmed, total: attempt.total },
                    syncEngine.isOnline(),
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
        <Button label="Record attempt" icon="plus" onPress={onCapture} disabled={captureBlocked} />
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
  content: { padding: spacing.md, paddingBottom: spacing.lg, gap: spacing.sm },
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
