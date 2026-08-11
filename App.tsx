import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { getMeta, openDatabase, setMeta } from './src/db/schema';
import { runRecoverySweep } from './src/sync/recovery';
import { syncEngine } from './src/sync/sync-engine';
import { getSession, getSessionState, SessionState } from './src/auth/session';
import { refreshTodayStops } from './src/db/stops-repo';
import { LoginScreen } from './src/screens/LoginScreen';
import { StopListScreen } from './src/screens/StopListScreen';
import { StopDetailScreen } from './src/screens/StopDetailScreen';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { UpdateRequiredScreen } from './src/screens/UpdateRequiredScreen';
import { MapsScreen } from './src/screens/MapsScreen';
import {
  configureGraceStore,
  gateLevel,
  GateLevel,
  restoreGraceClock,
  useVersionGate,
} from './src/version/version-gate';
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
    configureGraceStore({ read: getMeta, write: setMeta });
    await restoreGraceClock();

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
          <Image
            source={require('./assets/logo-mark.png')}
            style={styles.bootMark}
            resizeMode="contain"
          />
          <ActivityIndicator color={colors.primary} />
          <Text style={type.small}>Loading today&apos;s route</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  // A hard block still lets evidence upload: the screen itself drives sync.
  // It is shown only to a signed-in driver, because a blocked screen that
  // cannot re-authenticate could never actually upload anything.
  if (signedIn && gateLevel(gate) === GateLevel.Blocked) {
    return (
      <SafeAreaProvider>
        <View style={styles.root}>
          <StatusBar style="dark" />
          <UpdateRequiredScreen />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
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
          <MapsScreen
            onOpenStop={(stopId) => setRoute({ name: 'stop', stopId })}
            onBack={() => setRoute({ name: 'stops' })}
          />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.page },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
  },
  bootMark: { width: 96, height: 68, marginBottom: spacing.sm },
});
