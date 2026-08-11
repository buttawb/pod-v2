import { useState } from 'react';
import { KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BottomBar, Button, Screen, colors, spacing, type } from '../ui/components';
import { login } from '../auth/session';

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [employeeRef, setEmployeeRef] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(employeeRef.trim(), password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={styles.container}>
        <View style={styles.header}>
          <Text style={type.title}>Proof of Delivery</Text>
          <Text style={type.small}>Sign in to load today&apos;s route</Text>
        </View>

        <View style={styles.form}>
          <Text style={type.bodyStrong}>Driver ID</Text>
          <TextInput
            style={styles.input}
            value={employeeRef}
            onChangeText={setEmployeeRef}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="EMP-0000"
            placeholderTextColor={colors.textMuted}
            inputMode="text"
          />

          <Text style={type.bodyStrong}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            placeholder="Password"
            placeholderTextColor={colors.textMuted}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </KeyboardAvoidingView>

      <BottomBar>
        <Button
          label="Sign in"
          onPress={() => void submit()}
          loading={busy}
          disabled={employeeRef.trim().length === 0 || password.length === 0}
        />
      </BottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg, gap: spacing.xl },
  header: { gap: spacing.xs, marginTop: spacing.xl },
  form: { gap: spacing.sm },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 18,
    color: colors.text,
    backgroundColor: colors.background,
    marginBottom: spacing.sm,
  },
  error: { color: colors.alert, fontSize: 15, fontWeight: '600' },
});
