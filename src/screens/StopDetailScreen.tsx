import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { BottomBar, Button, Card, Screen, SyncBadge, colors, spacing, type } from '../ui/components';
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
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={type.title}>{stop?.address ?? 'Stop'}</Text>
          <Text style={type.small}>{stop?.postcode}</Text>
          {stop?.removed === 1 ? (
            <Text style={styles.removed}>
              Removed by dispatch. Evidence you already captured still uploads.
            </Text>
          ) : null}
        </View>

        <Text style={[type.heading, styles.sectionTitle]}>
          Attempts {attempts.length > 0 ? `(${attempts.length})` : ''}
        </Text>

        {attempts.length === 0 ? (
          <Card>
            <Text style={type.body}>No attempts recorded yet.</Text>
          </Card>
        ) : (
          attempts.map((attempt) => (
            <Card key={attempt.client_attempt_id}>
              <View style={styles.attemptRow}>
                <View style={styles.attemptDetails}>
                  <Text style={type.bodyStrong}>
                    #{attempt.attempt_no}{' '}
                    {attempt.outcome ? OUTCOME_SPECS[attempt.outcome].label : 'Unknown'}
                  </Text>
                  <Text style={type.small}>{formatTime(attempt.captured_at)}</Text>
                  {attempt.sync_state === SyncState.NeedsAttention ? (
                    <Text style={styles.error}>
                      {attempt.last_error_message ?? 'Could not reach the server'}
                      {'\n'}Everything is still saved on this phone.
                    </Text>
                  ) : null}
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
                <View style={styles.retry}>
                  <Button
                    label="Retry now"
                    variant="secondary"
                    onPress={() => {
                      void retryNow(attempt.client_attempt_id).then(() => syncEngine.kick());
                    }}
                  />
                </View>
              ) : null}
            </Card>
          ))
        )}
      </ScrollView>

      <BottomBar>
        {captureBlocked ? (
          <Text style={styles.blocked}>
            Update required before recording new attempts. Uploads still work.
          </Text>
        ) : null}
        <Button label="Record attempt" onPress={onCapture} disabled={captureBlocked} />
        <Button label="Back to today" variant="secondary" onPress={onBack} />
      </BottomBar>
    </Screen>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.lg },
  header: { padding: spacing.md, gap: 2 },
  sectionTitle: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  attemptRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  attemptDetails: { flex: 1, gap: 2 },
  error: { color: colors.alert, fontSize: 14, marginTop: 4 },
  removed: { color: colors.progress, fontSize: 14, marginTop: 4 },
  blocked: { color: colors.alert, fontSize: 14, fontWeight: '600' },
  retry: { marginTop: spacing.sm },
});
