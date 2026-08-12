import { useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  Field,
  Input,
  Screen,
  colors,
  radius,
  spacing,
  type,
  useEdgePadding,
} from '../ui/components';
import { login } from '../auth/session';
import { syncEngine } from '../sync/sync-engine';
import { APP_VERSION } from '../config';

// Demo credentials, prefilled in development builds only so a reviewer (or
// a simulator, whose keyboard mangles '#') can get in without typing. The
// bundler strips this branch from a release build.
const DEV_DRIVER = __DEV__ ? 'EMP-TEST-001' : '';
const DEV_PASSWORD = __DEV__ ? 'TestDriver#2026' : '';

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const insets = useSafeAreaInsets();
  const edge = useEdgePadding();
  const [employeeRef, setEmployeeRef] = useState(DEV_DRIVER);
  const [password, setPassword] = useState(DEV_PASSWORD);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(employeeRef.trim(), password);
      // Signing back in unfreezes a queue that a failed refresh had paused.
      void syncEngine.kick();
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  const ready = employeeRef.trim().length > 0 && password.length > 0;

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Scrolls so the form still clears the keyboard on a small screen. */}
        <ScrollView
          contentContainerStyle={[
            styles.content,
            edge,
            { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.lg },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.brand}>
            <Image
              source={require('../../assets/logo-mark.png')}
              style={styles.mark}
              resizeMode="contain"
            />
            <Text style={type.title}>Proof of Delivery</Text>
            <Text style={type.small}>Sign in to load today&apos;s route</Text>
          </View>

          <Card style={styles.form}>
            <Field label="Driver ID">
              <Input
                value={employeeRef}
                onChangeText={setEmployeeRef}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="EMP-0000"
                returnKeyType="next"
              />
            </Field>

            <Field label="Password">
              <Input
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                placeholder="Password"
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
              />
            </Field>

            {error ? (
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={16} color={colors.alert} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Button label="Sign in" onPress={() => void submit()} loading={busy} disabled={!ready} />
          </Card>

          <View style={styles.assurance}>
            <Feather name="wifi-off" size={16} color={colors.textMuted} />
            <View style={styles.assuranceText}>
              <Text style={type.bodyStrong}>Works without signal</Text>
              <Text style={type.small}>
                Evidence you capture is saved on this phone first and uploads on its own when you
                have signal again.
              </Text>
            </View>
          </View>

          <Text style={styles.version}>Version {APP_VERSION}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    gap: spacing.lg,
    justifyContent: 'center',
    // Rotated, the screen is far wider than the form needs. Keeping the card
    // a fixed column stops the fields becoming a single unreadable line.
    width: '100%',
    maxWidth: 460,
    alignSelf: 'center',
  },
  brand: { alignItems: 'center', gap: 2 },
  mark: { width: 92, height: 66, marginBottom: spacing.md },
  form: { gap: spacing.md },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.alertSurface,
    borderRadius: radius.lg,
    padding: spacing.sm + 2,
  },
  errorText: { flex: 1, color: colors.alert, fontSize: 14, fontWeight: '600' },
  assurance: {
    flexDirection: 'row',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.xs,
  },
  assuranceText: { flex: 1, gap: 2 },
  version: { ...type.meta, textAlign: 'center' },
});
