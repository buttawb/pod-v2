import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { openDatabase } from './src/db/schema';
import { runRecoverySweep } from './src/sync/recovery';
import { syncEngine } from './src/sync/sync-engine';
import { getSession, getSessionState, SessionState } from './src/auth/session';
import { refreshTodayStops } from './src/db/stops-repo';
import { LoginScreen } from './src/screens/LoginScreen';
import { StopListScreen } from './src/screens/StopListScreen';
import { StopDetailScreen } from './src/screens/StopDetailScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { UpdateRequiredScreen } from './src/screens/UpdateRequiredScreen';
import { gateLevel, GateLevel, useVersionGate } from './src/version/version-gate';
import { colors, spacing, type } from './src/ui/theme';

type Route =
  | { name: 'stops' }
  | { name: 'stop'; stopId: string }
  | { name: 'capture'; stopId: string }
  | { name: 'maps' };

export default function App() {
  const [booting, setBooting] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [route, setRoute] = useState<Route>({ name: 'stops' });
  const gate = useVersionGate();

  const boot = useCallback(async () => {
    // Order matters: the database must be open and swept before anything
    // reads it, and none of this requires a network.
    await openDatabase();
    await runRecoverySweep();

    const session = await getSession();
    const state = await getSessionState();
    setSignedIn(session !== null && state === SessionState.Ok);
    setBooting(false);

    // Network work is fire-and-forget: a cold start in a basement must
    // reach the stop list regardless.
    void refreshTodayStops().catch(() => undefined);
    void syncEngine.kick();
  }, []);

  useEffect(() => {
    void boot();
    return syncEngine.start();
  }, [boot]);

  useEffect(() => {
    useVersionGate.getState().setRouteActive(signedIn);
  }, [signedIn]);

  if (booting) {
    return (
      <SafeAreaProvider>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={type.small}>Loading today&apos;s route</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  // A hard block still lets evidence upload: the screen itself drives sync.
  if (gateLevel(gate) === GateLevel.Blocked) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.safe}>
          <StatusBar style="dark" />
          <UpdateRequiredScreen />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        {!signedIn ? (
          <LoginScreen
            onSignedIn={() => {
              setSignedIn(true);
              void refreshTodayStops().catch(() => undefined);
            }}
          />
        ) : route.name === 'stops' ? (
          <StopListScreen
            onOpenStop={(stopId) => setRoute({ name: 'stop', stopId })}
            onOpenMap={() => setRoute({ name: 'maps' })}
          />
        ) : route.name === 'stop' ? (
          <StopDetailScreen
            stopId={route.stopId}
            onCapture={() => setRoute({ name: 'capture', stopId: route.stopId })}
            onBack={() => setRoute({ name: 'stops' })}
          />
        ) : route.name === 'capture' ? (
          <CaptureScreen
            stopId={route.stopId}
            onDone={() => setRoute({ name: 'stop', stopId: route.stopId })}
          />
        ) : (
          <View style={styles.center}>
            <Text style={type.body}>Maps land in the next slice.</Text>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
});
