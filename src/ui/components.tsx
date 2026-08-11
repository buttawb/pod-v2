import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, TOUCH_TARGET, toneStyles, type } from './theme';
import type { Badge } from '../sync/badges';

export function SyncBadge({ badge }: { badge: Badge }) {
  const tone = toneStyles[badge.tone];
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      {/* Icon plus colour: status must survive a colour-blind driver and glare. */}
      <Text style={[styles.badgeIcon, { color: tone.fg }]}>{tone.icon}</Text>
      <Text style={[styles.badgeText, { color: tone.fg }]} numberOfLines={1}>
        {badge.label}
      </Text>
    </View>
  );
}

export function Banner({ label, tone }: { label: string; tone: Badge['tone'] }) {
  const style = toneStyles[tone];
  return (
    <View style={[styles.banner, { backgroundColor: style.bg }]}>
      <Text style={[styles.bannerText, { color: style.fg }]}>{label}</Text>
    </View>
  );
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
}

export function Button({ label, onPress, variant = 'primary', disabled, loading }: ButtonProps) {
  const background =
    variant === 'primary' ? colors.primary : variant === 'danger' ? colors.alert : colors.surface;
  const foreground = variant === 'secondary' ? colors.text : colors.primaryText;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 },
        variant === 'secondary' && styles.buttonOutlined,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <Text style={[styles.buttonText, { color: foreground }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  if (!onPress) return <View style={styles.card}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.surface }]}
    >
      {children}
    </Pressable>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>;
}

/** Primary actions sit at the bottom, inside thumb reach. */
export function BottomBar({ children }: { children: ReactNode }) {
  return <View style={styles.bottomBar}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 6,
  },
  badgeIcon: { fontSize: 14, fontWeight: '700' },
  badgeText: { fontSize: 14, fontWeight: '600' },
  banner: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bannerText: { fontSize: 15, fontWeight: '600' },
  button: {
    minHeight: TOUCH_TARGET,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  buttonOutlined: { borderWidth: 1, borderColor: colors.border },
  buttonText: { fontSize: 17, fontWeight: '700' },
  card: {
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: TOUCH_TARGET + spacing.md,
    justifyContent: 'center',
  },
  bottomBar: {
    padding: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
});

export { type, colors, spacing };
