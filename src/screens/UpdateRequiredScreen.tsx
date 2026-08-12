import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomBar,
  Button,
  Card,
  Screen,
  colors,
  radius,
  spacing,
  type,
  useEdgePadding,
  CONTENT_MAX_WIDTH,
} from '../ui/components';
import { syncCounts } from '../db/attempts-repo';
import { syncEngine } from '../sync/sync-engine';
import { APK_DOWNLOAD_URL } from '../config';

/**
 * A hard block stops NEW work, never the evidence already on this handset.
 * Stranding captured proof costs more than any bug an update fixes, and a
 * driver who fears losing their work will dodge updates entirely.
 */
export function UpdateRequiredScreen() {
  const insets = useSafeAreaInsets();
  const edge = useEdgePadding();
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

  const clear = pending === 0;

  return (
    <Screen>
      <View style={[styles.body, edge, { paddingTop: insets.top + spacing.lg }]}>
        <View style={styles.icon}>
          <Feather name="download" size={26} color={colors.primary} />
        </View>

        <View style={styles.copy}>
          <Text style={type.title}>Update required</Text>
          <Text style={type.body}>
            This version can no longer be used for new deliveries. Install the latest build to carry
            on.
          </Text>
        </View>

        <Card style={styles.evidence}>
          <View style={styles.evidenceRow}>
            <Feather
              name={clear ? 'check-circle' : 'upload-cloud'}
              size={18}
              color={clear ? colors.good : colors.progress}
            />
            <Text style={[type.bodyStrong, styles.evidenceTitle]}>
              {clear
                ? 'All evidence has reached the server'
                : `${pending} attempt${pending > 1 ? 's are' : ' is'} still on this phone`}
            </Text>
          </View>
          <Text style={type.small}>
            {clear
              ? 'Nothing will be lost by updating.'
              : 'Upload now before updating so nothing is lost.'}
          </Text>
        </Card>
      </View>

      <BottomBar>
        {pending > 0 ? (
          <Button
            label="Upload evidence now"
            icon="upload-cloud"
            loading={syncing}
            onPress={() => {
              setSyncing(true);
              void syncEngine.kick().finally(() => setSyncing(false));
            }}
          />
        ) : null}
        <Button
          label="Get the update"
          icon="download"
          variant={pending > 0 ? 'secondary' : 'primary'}
          onPress={() => void Linking.openURL(APK_DOWNLOAD_URL)}
        />
      </BottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingVertical: spacing.lg,
    gap: spacing.md,
    justifyContent: 'center',
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { gap: spacing.xs },
  evidence: { gap: spacing.xs, marginTop: spacing.sm },
  evidenceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  evidenceTitle: { flex: 1 },
});
