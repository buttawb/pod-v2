import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, shadow, spacing, TOUCH_TARGET, toneStyles, type, type Tone } from './theme';
import type { Badge as BadgeModel } from '../sync/badges';

type IconName = keyof typeof Feather.glyphMap;

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Height of the on-screen keyboard, measured rather than inferred.
 *
 * The manifest asks for android:windowSoftInputMode="adjustResize" and it does
 * nothing, because the app draws edge to edge: the window no longer shrinks
 * when the keyboard opens, so there is no resize for anything to react to.
 * KeyboardAvoidingView is built on that same resize and is equally inert here,
 * which is why adding one would not have fixed the note field.
 *
 * The keyboard events still fire and still carry the real height, so that is
 * what we use.
 */
export function useKeyboardInset(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) =>
      setHeight(event.endCoordinates.height),
    );
    const hidden = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return height;
}

export function Screen({ children, plain }: { children: ReactNode; plain?: boolean }) {
  const keyboard = useKeyboardInset();

  // Lift by the full keyboard height, nothing clever. An earlier version took
  // the bottom safe-area inset off here on the grounds that BottomBar pads for
  // it separately, which left the Complete button clipped by exactly that
  // much: the bar's own padding sits inside the bar and moves its contents up
  // from an edge that was itself still under the keyboard. BottomBar drops its
  // inset while the keyboard is open instead, so the two never double count.
  return (
    <View
      style={[
        styles.screen,
        plain && { backgroundColor: colors.background },
        keyboard > 0 && { paddingBottom: keyboard },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Horizontal page padding that also clears the display cutout.
 *
 * In portrait the cutout sits above the content and left/right are zero, so
 * this reads as ordinary padding. Rotate the handset and the cutout moves to
 * one side: without this a card edge, or worse a floating map control, ends
 * up underneath it.
 */
export function useEdgePadding(): { paddingLeft: number; paddingRight: number } {
  const insets = useSafeAreaInsets();
  return {
    paddingLeft: insets.left + spacing.md,
    paddingRight: insets.right + spacing.md,
  };
}

/**
 * Caps a reading column on a wide screen. A landscape handset is roughly
 * twice as wide as it is tall, and a form or a stat card stretched across all
 * of it is harder to scan, not easier.
 */
export const CONTENT_MAX_WIDTH = 640;

/**
 * Metronic's page header: title, supporting line, and an optional action on
 * the right. The back affordance is a target in its own right rather than a
 * chevron glued to the title, because it is pressed with a thumb.
 */
export function PageHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const edge = useEdgePadding();
  return (
    <View style={[styles.header, edge, { paddingTop: insets.top + spacing.sm }]}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={onBack}
          hitSlop={8}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressedSurface]}
        >
          <Feather name="chevron-left" size={22} color={colors.text} />
        </Pressable>
      ) : null}
      <View style={styles.headerText}>
        <Text style={type.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={type.small} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

/** Primary actions sit at the bottom, inside thumb reach and above the inset. */
export function BottomBar({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const edge = useEdgePadding();
  const keyboard = useKeyboardInset();

  // The bottom inset clears the navigation bar. With the keyboard open there
  // is no navigation bar to clear: the keyboard is drawn over it, and Screen
  // has already lifted this whole bar above the keyboard. Keeping the inset
  // then adds a second gap and pushes the button back under the keys.
  const paddingBottom = keyboard > 0 ? spacing.md : Math.max(insets.bottom, spacing.md);

  return (
    <View style={[styles.bottomBar, edge, { paddingBottom }]}>
      <View style={styles.bottomBarInner}>{children}</View>
    </View>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={[type.label, styles.sectionLabel]}>{children}</Text>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                   */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  onPress,
  style,
  padded = true,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  padded?: boolean;
}) {
  const base = [styles.card, padded && styles.cardPadded, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [base, pressed && styles.pressedCard]}>
      {children}
    </Pressable>
  );
}

/** A card that behaves like a list row: leading slot, body, trailing chevron. */
export function ListCard({
  icon,
  title,
  subtitle,
  onPress,
  leading,
  trailing,
  children,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card onPress={onPress}>
      <View style={styles.listRow}>
        {leading ?? (icon ? <IconTile name={icon} /> : null)}
        <View style={styles.listBody}>
          <Text style={type.bodyStrong} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? <Text style={type.small}>{subtitle}</Text> : null}
          {children}
        </View>
        {trailing ?? (onPress ? <Feather name="chevron-right" size={20} color={colors.textSubtle} /> : null)}
      </View>
    </Card>
  );
}

export function IconTile({ name, tone = 'neutral' }: { name: IconName; tone?: Tone }) {
  const t = toneStyles[tone];
  return (
    <View style={[styles.iconTile, { backgroundColor: t.bg }]}>
      <Feather name={name} size={18} color={t.fg} />
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  body,
}: {
  icon: IconName;
  title: string;
  body?: string;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Feather name={icon} size={24} color={colors.textMuted} />
      </View>
      <Text style={type.bodyStrong}>{title}</Text>
      {body ? <Text style={[type.small, styles.emptyBody]}>{body}</Text> : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Metronic's badge in its "light" appearance. Status is carried by a dot and a
 * word, never colour alone, so it survives glare and colour blindness.
 */
export function SyncBadge({ badge }: { badge: BadgeModel }) {
  const tone = toneStyles[badge.tone];
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <View style={[styles.badgeDot, { backgroundColor: tone.dot }]} />
      <Text style={[styles.badgeText, { color: tone.fg }]} numberOfLines={1}>
        {badge.label}
      </Text>
    </View>
  );
}

export function Banner({ label, tone }: { label: string; tone: Tone }) {
  const t = toneStyles[tone];
  return (
    <View style={[styles.banner, { backgroundColor: t.bg, borderColor: t.dot }]}>
      <Feather name={t.icon as IconName} size={16} color={t.fg} />
      <Text style={[styles.bannerText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

/** Thin progress rail, used for "n of m done" without spending vertical space. */
export function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${pct * 100}%` }]} />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
}: ButtonProps) {
  const solid = variant === 'primary' || variant === 'danger';
  const background =
    variant === 'primary'
      ? colors.primary
      : variant === 'danger'
        ? colors.alertSolid
        : variant === 'ghost'
          ? 'transparent'
          : colors.background;
  const foreground = solid ? colors.primaryText : colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background },
        variant === 'secondary' && styles.buttonOutlined,
        disabled ? styles.buttonDisabled : pressed && styles.buttonPressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <>
          {icon ? <Feather name={icon} size={18} color={foreground} /> : null}
          <Text style={[styles.buttonText, { color: foreground }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {hint ? <Text style={type.meta}>{hint}</Text> : null}
    </View>
  );
}

/**
 * Metronic's input, sized up: 54dp tall and 17pt so it stays usable with a
 * gloved thumb. `multiline` grows it into a note box.
 */
export function Input({ multiline, style, ...props }: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.textSubtle}
      multiline={multiline}
      style={[styles.input, multiline && styles.inputMultiline, style]}
      {...props}
    />
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && !selected && styles.pressedSurface,
      ]}
    >
      {selected ? <Feather name="check" size={14} color={colors.primaryText} /> : null}
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerText: { flex: 1, gap: 1 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.secondary,
  },
  pressedSurface: { backgroundColor: colors.input },

  bottomBar: {
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  // In landscape the bar spans a very wide screen; the actions stay a
  // thumb-sized column in the middle rather than stretching edge to edge.
  bottomBarInner: {
    gap: spacing.sm,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },

  sectionLabel: { paddingHorizontal: spacing.xs, paddingBottom: spacing.xs },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },

  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    ...shadow.card,
  },
  cardPadded: { padding: spacing.md },
  pressedCard: { backgroundColor: colors.secondary },

  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: TOUCH_TARGET },
  listBody: { flex: 1, gap: 2 },
  iconTile: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  empty: { paddingVertical: spacing.xl, paddingHorizontal: spacing.lg, alignItems: 'center', gap: spacing.sm },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyBody: { textAlign: 'center' },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.md,
    gap: 6,
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 13, fontWeight: '600' },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.lg,
    borderLeftWidth: 3,
  },
  bannerText: { flex: 1, fontSize: 14, fontWeight: '600' },

  progressTrack: {
    height: 6,
    borderRadius: radius.full,
    backgroundColor: colors.secondary,
    overflow: 'hidden',
  },
  // The mark's cyan, which is too light to sit under text but is exactly right
  // as a fill the driver reads at a glance.
  progressFill: { height: '100%', borderRadius: radius.full, backgroundColor: colors.accent },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: TOUCH_TARGET + 4,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
  },
  buttonOutlined: { borderWidth: 1, borderColor: colors.input },
  buttonPressed: { opacity: 0.88 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 17, fontWeight: '600' },

  field: { gap: 6 },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
  input: {
    minHeight: 54,
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    fontSize: 17,
    color: colors.text,
    backgroundColor: colors.background,
  },
  inputMultiline: { minHeight: 96, paddingTop: spacing.sm + 4, textAlignVertical: 'top' },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius.full,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 15, fontWeight: '500', color: colors.text },
  chipTextSelected: { color: colors.primaryText },
});

export { type, colors, spacing, radius, shadow };
