# Proof-of-Delivery v2 - Driver App

Android app (React Native / Expo) for couriers: work today's stop list,
capture proof-of-delivery evidence offline, and reconcile with the server when
signal returns.

Backend, infrastructure and the design write-up live in
**[pod-v2-backend](https://github.com/buttawb/pod-v2-backend)** (see its
`DECISIONS.md`).

| | |
|---|---|
| Install | https://pod-v2-apk-856942459927.s3.ap-southeast-1.amazonaws.com/pod-v2.apk |
| API | https://18.139.240.68.sslip.io |
| Driver login | `EMP-TEST-001` / `TestDriver#2026` |

## What it does

Sign in once (the session survives restarts). Today's stops load from the
device database, so a cold start with no signal still works. At a stop the
driver records an **attempt**: one of six outcomes, each demanding its own
evidence (signature, photos, neighbour's house number, reason), plus GPS with
accuracy, time, device, and a scanned or typed barcode. A stop can have many
attempts. Two maps: the driver's own route with a live position, and the whole
depot's ~5,000 stops filterable by status.

## How the offline path works

The device database is the system of record until the server says otherwise.
Evidence is written to disk **before** any network call, every call is
idempotent, and the UI never claims more than the server has confirmed:
"On server" appears only once the server has verified the attempt *and* every
declared photo.

```
src/
  domain/outcomes.ts    the evidence matrix (mirrors the server's)
  db/                   SQLite schema, attempt and stop repositories
  sync/
    state-machine.ts    legal transitions, backoff, failure classes
    sync-engine.ts      the worker: submit, upload, finalize
    recovery.ts         cold-start sweep after a force-quit
    badges.ts           what the driver is told, and when
  capture/              camera, signature pad, barcode, file handling
  maps/                 MapLibre sources, layers, perf harness
  version/              forced-update gate
```

Run `npm test` for the sync-engine, evidence-matrix, badge-honesty and
version-gate suites (75 tests, no device required).

## Build

```bash
npm install
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease   # APK, for sideloading
```

Release signing reads `~/.pod-v2-signing/keystore.properties`; without it the
build falls back to debug signing, so a clean checkout still compiles. **Back
that keystore up**: the fallback means a machine without it produces an
installable but wrongly-signed artifact with no error.

### For a Google Play release

Play requires an App Bundle, not an APK, and the store build should not carry
the development launcher:

```bash
# remove "expo-dev-client" from expo.plugins in app.json first
npx expo prebuild --platform android --clean
cd android && ./gradlew bundleRelease     # -> app/build/outputs/bundle/release
```

Keep the npm dependency: only the plugin entry needs to go, and only for the
uploaded build.

`app.json` blocks four permissions Expo's manifest template adds that nothing
here uses (`SYSTEM_ALERT_WINDOW`, `VIBRATE`, and the two external-storage
ones). Verify they are absent before uploading:

```bash
unzip -p android/app/build/outputs/bundle/release/app-release.aab \
  base/manifest/AndroidManifest.xml | strings | grep -i "ALERT_WINDOW\|RECORD_AUDIO"
```

`APP_VERSION` in `src/config.ts` must always equal `expo.version` in
`app.json`: the server compares it against `X-Min-App-Version`, and a drift
would block the wrong builds from capturing evidence.

## Depot map performance

The map ships three render modes so before and after can be measured on the
same scripted camera tour rather than estimated:

```bash
EXPO_PUBLIC_RENDER_MODE=markers|symbols|clustered npx expo run:android --variant release
adb shell dumpsys gfxinfo com.podv2.driver reset
# run the in-app camera tour, then
adb shell dumpsys gfxinfo com.podv2.driver
```

`markers` is the naive baseline (one native view per stop), `symbols` an
unclustered GPU layer, and `clustered` what ships.
