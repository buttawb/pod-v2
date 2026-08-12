import { Linking, Platform } from 'react-native';

/**
 * Hands a stop off to the phone's navigation app.
 *
 * We do not draw routes ourselves. Turn-by-turn is a solved, safety-critical
 * problem with live traffic and lane guidance behind it, and a driver already
 * has an app they trust mounted on the windscreen. Reimplementing a worse one
 * inside a proof-of-delivery app would be the wrong thing to own.
 *
 * Android gets Google's navigation intent, which starts driving directions
 * immediately rather than dropping the driver on a map they have to tap again.
 * If that app is absent (Chinese ROMs, de-Googled handsets) the universal
 * https link still resolves, opening Google Maps when installed and the
 * browser otherwise, so the address is never a dead end.
 */
export async function navigateTo(lat: number, lng: number, label?: string): Promise<void> {
  const destination = `${lat},${lng}`;
  const query = label ? `${destination}(${encodeURIComponent(label)})` : destination;

  const preferred = Platform.select({
    android: `google.navigation:q=${destination}&mode=d`,
    ios: `comgooglemaps://?daddr=${destination}&directionsmode=driving`,
    default: '',
  });

  const fallbacks = [
    // Lets the driver's own default (Waze, Organic Maps) answer if it wants to.
    `geo:${destination}?q=${query}`,
    `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`,
  ];

  for (const url of [preferred, ...fallbacks]) {
    if (!url) continue;
    try {
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
        return;
      }
    } catch {
      // Try the next scheme rather than failing the whole hand-off.
    }
  }

  // The https form is openable on any device with a browser; if even this
  // throws there is nothing sensible left to try.
  await Linking.openURL(fallbacks[fallbacks.length - 1]);
}
