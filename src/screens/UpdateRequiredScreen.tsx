import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { BottomBar, Button, Screen, colors, spacing, type } from '../ui/components';
import { syncCounts } from '../db/attempts-repo';
import { syncEngine } from '../sync/sync-engine';
import { APK_DOWNLOAD_URL } from '../config';

/**
 * A hard block stops NEW work, never the evidence already on this handset.
 * Stranding captured proof costs more than any bug an update fixes, and a
 * driver who fears losing their work will dodge updates entirely.
 */
export function UpdateRequiredScreen() {
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const counts = await syncCounts();
    setPending(counts.onDevice + counts.sending + counts.uploading + counts.needsAttention);
  }, []);

  useEffect(() => {
    void load();
    return syncEngine.subscribe(() => void load());
  }, [load]);

  return (
    <Screen>
      <View style={styles.body}>
        <Text style={type.title}>Update required</Text>
        <Text style={type.body}>
          This version can no longer be used for new deliveries. Install the latest build to carry on.
        </Text>

        <View style={styles.evidence}>
          <Text style={type.bodyStrong}>
            {pending === 0
              ? 'All evidence on this phone has reached the server.'
              : `${pending} attempt${pending > 1 ? 's are' : ' is'} still on this phone.`}
          </Text>
          <Text style={type.small}>
            {pending === 0
              ? 'Nothing will be lost by updating.'
              : 'Upload now before updating so nothing is lost.'}
          </Text>
        </View>
      </View>

      <BottomBar>
        {pending > 0 ? (
          <Button
            label="Upload evidence now"
            loading={syncing}
            onPress={() => {
              setSyncing(true);
              void syncEngine.kick().finally(() => setSyncing(false));
            }}
          />
        ) : null}
        <Button
          label="Get the update"
          variant={pending > 0 ? 'secondary' : 'primary'}
          onPress={() => void Linking.openURL(APK_DOWNLOAD_URL)}
        />
      </BottomBar>
    </Screen>
  );
}


const styles = StyleSheet.create({
  body: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
  evidence: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.xs,
  },
});
