/**
 * Built for a driver holding a parcel in one hand, outdoors, in a hurry:
 * high contrast for sunlight, large type, 48dp minimum targets, and status
 * carried by icon plus colour rather than colour alone.
 */
export const colors = {
  background: '#FFFFFF',
  surface: '#F4F6F8',
  border: '#D7DDE3',
  text: '#0B1520',
  textMuted: '#5A6875',
  primary: '#0B5FD6',
  primaryText: '#FFFFFF',
  good: '#0E7C3F',
  goodSurface: '#E6F4EC',
  progress: '#9A5B00',
  progressSurface: '#FDF0DC',
  alert: '#B3231C',
  alertSurface: '#FCE9E8',
  neutralSurface: '#EBEFF3',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const type = {
  title: { fontSize: 26, fontWeight: '700' as const, color: colors.text },
  heading: { fontSize: 20, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: 17, color: colors.text },
  bodyStrong: { fontSize: 17, fontWeight: '600' as const, color: colors.text },
  small: { fontSize: 14, color: colors.textMuted },
} as const;

/** Anything tappable is at least this tall. */
export const TOUCH_TARGET = 48;

export const toneStyles = {
  neutral: { bg: colors.neutralSurface, fg: colors.textMuted, icon: '•' },
  progress: { bg: colors.progressSurface, fg: colors.progress, icon: '↑' },
  good: { bg: colors.goodSurface, fg: colors.good, icon: '✓' },
  alert: { bg: colors.alertSurface, fg: colors.alert, icon: '!' },
} as const;
