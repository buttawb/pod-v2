import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BottomBar, Button, Screen, colors, spacing, type } from '../ui/components';
import { login } from '../auth/session';
import { syncEngine } from '../sync/sync-engine';
import { APP_VERSION } from '../config';

// Demo credentials, prefilled in development builds only so a reviewer (or
// a simulator, whose keyboard mangles '#') can get in without typing. The
// bundler strips this branch from a release build.
const DEV_DRIVER = __DEV__ ? 'EMP-TEST-001' : '';
const DEV_PASSWORD = __DEV__ ? 'TestDriver#2026' : '';

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
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

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Scrolls so the form still reaches the keyboard on a small screen. */}
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.brand}>
            <View style={styles.mark}>
              <Text style={styles.markText}>PoD</Text>
            </View>
            <Text style={type.title}>Proof of Delivery</Text>
            <Text style={type.small}>Sign in to load today&apos;s route</Text>
          </View>

          <View style={styles.form}>
            <View style={styles.field}>
              <Text style={styles.label}>Driver ID</Text>
              <TextInput
                style={styles.input}
                value={employeeRef}
                onChangeText={setEmployeeRef}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="EMP-0000"
                placeholderTextColor={colors.textMuted}
                returnKeyType="next"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                placeholder="Password"
                placeholderTextColor={colors.textMuted}
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
              />
            </View>

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.assurance}>
            <Text style={styles.assuranceTitle}>Works without signal</Text>
            <Text style={styles.assuranceBody}>
              Evidence you capture is saved on this phone first and uploads on its own when you
              have signal again.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <BottomBar>
        <Button
          label="Sign in"
          onPress={() => void submit()}
          loading={busy}
          disabled={employeeRef.trim().length === 0 || password.length === 0}
        />
        <Text style={styles.version}>Version {APP_VERSION}</Text>
      </BottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    padding: spacing.lg,
    gap: spacing.lg,
    justifyContent: 'center',
  },
  brand: { alignItems: 'center', gap: spacing.xs },
  mark: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  markText: { color: colors.primaryText, fontSize: 20, fontWeight: '800' },
  form: { gap: spacing.md },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600', color: colors.text },
  input: {
    minHeight: 54,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    fontSize: 18,
    color: colors.text,
    backgroundColor: colors.background,
  },
  errorBox: {
    backgroundColor: colors.alertSurface,
    borderRadius: 10,
    padding: spacing.sm,
  },
  errorText: { color: colors.alert, fontSize: 15, fontWeight: '600' },
  assurance: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: 4,
  },
  assuranceTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  assuranceBody: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },
  version: { fontSize: 12, color: colors.textMuted, textAlign: 'center' },
});
