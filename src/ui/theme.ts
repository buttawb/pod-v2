import { Platform, type TextStyle, type ViewStyle } from 'react-native';

/**
 * Metronic 9's design tokens, ported to React Native: a zinc neutral ramp,
 * 8px corners, and status carried by soft-tinted "light" badges.
 *
 * The primary is the brand mark's own deep blue rather than Metronic's default
 * zinc-900. Metronic drives its primary through --color-primary-*, so swapping
 * it is the theme working as intended, not a departure from it.
 *
 * Which of the mark's three blues does what is a contrast decision. #1C56A8
 * carries white text at roughly 7:1, so it takes every filled control. #00ADEF
 * is about 2.3:1 against white, so it never sits under text: it is the accent
 * on progress fills, the logo, and selection edges only.
 *
 * Two deliberate departures from Metronic's metrics, both for a driver holding
 * a parcel outdoors in a hurry: body text stays at 16-17pt rather than 13-14pt,
 * and every target is at least 48dp. The smaller sizes are kept for secondary
 * metadata only, where a missed glance costs nothing.
 */
export const brand = {
  cyan: '#00ADEF',
  blue: '#3771C2',
  deep: '#1C56A8',
} as const;

export const colors = {
  /** Page behind the cards. Metronic sits content on a faint zinc wash. */
  page: '#F7F7F8',
  background: '#FFFFFF',
  card: '#FFFFFF',

  /** --border sits between zinc-100 and zinc-200; --input is zinc-200. */
  border: '#E9E9EB',
  input: '#E4E4E7',
  ring: '#A1A1AA',

  text: '#09090B', // zinc-950
  textMuted: '#71717A', // zinc-500
  textSubtle: '#A1A1AA', // zinc-400

  primary: brand.deep,
  primaryPressed: '#17488C',
  primaryText: '#FFFFFF',
  /** Tint behind selected rows and brand badges, mixed from the mark's cyan. */
  primarySurface: '#E8F4FD',
  accent: brand.cyan,

  secondary: '#F4F4F5', // zinc-100

  /** Badge "light" appearance: soft surface, darker accent text. */
  good: '#166534',
  goodSurface: '#DCFCE7',
  goodSolid: '#22C55E',

  progress: '#A16207',
  progressSurface: '#FEF9C3',
  progressSolid: '#EAB308',

  alert: '#B91C1C',
  alertSurface: '#FEF2F2',
  alertSolid: '#DC2626',

  info: brand.deep,
  infoSurface: '#E8F4FD',
  infoSolid: brand.cyan,

  neutralSurface: '#F4F4F5',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

/** Metronic's --radius is 0.5rem, with sm/md/lg/xl stepping around it. */
export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  full: 999,
} as const;

export const type = {
  title: { fontSize: 26, fontWeight: '700' as const, color: colors.text, letterSpacing: -0.4 },
  heading: { fontSize: 20, fontWeight: '700' as const, color: colors.text, letterSpacing: -0.2 },
  subheading: { fontSize: 17, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 17, color: colors.text },
  bodyStrong: { fontSize: 17, fontWeight: '600' as const, color: colors.text },
  small: { fontSize: 14, color: colors.textMuted },
  /** Metronic's --text-2sm, for metadata that never carries a decision. */
  meta: { fontSize: 13, color: colors.textMuted },
  /** Uppercase section label above a group of cards. */
  label: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: colors.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
  },
} satisfies Record<string, TextStyle>;

/** Anything tappable is at least this tall. */
export const TOUCH_TARGET = 48;

/**
 * Metronic's cards are almost flat: a hairline border does the separating and
 * the shadow only lifts them off the wash. Android has no shadow colour
 * control worth using at this weight, so elevation stands in.
 */
export const shadow = {
  card: Platform.select<ViewStyle>({
    ios: {
      shadowColor: '#09090B',
      shadowOpacity: 0.04,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
    },
    android: { elevation: 1 },
    default: {},
  }) as ViewStyle,
  raised: Platform.select<ViewStyle>({
    ios: {
      shadowColor: '#09090B',
      shadowOpacity: 0.08,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    android: { elevation: 4 },
    default: {},
  }) as ViewStyle,
} as const;

export type Tone = 'neutral' | 'progress' | 'good' | 'alert' | 'info';

/** Icon names are Feather, which is what Lucide (Metronic's set) grew out of. */
export const toneStyles = {
  neutral: { bg: colors.neutralSurface, fg: colors.textMuted, dot: colors.textSubtle, icon: 'circle' },
  progress: { bg: colors.progressSurface, fg: colors.progress, dot: colors.progressSolid, icon: 'upload-cloud' },
  good: { bg: colors.goodSurface, fg: colors.good, dot: colors.goodSolid, icon: 'check-circle' },
  alert: { bg: colors.alertSurface, fg: colors.alert, dot: colors.alertSolid, icon: 'alert-circle' },
  info: { bg: colors.infoSurface, fg: colors.info, dot: colors.infoSolid, icon: 'info' },
} as const;
