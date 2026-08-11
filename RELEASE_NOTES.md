# Release notes

## 2.0.0 (versionCode 200)

First Play release. Proof of Delivery v2 replaces the v1 driver app.

### What's new (Play Console copy, 476 characters)

```
Proof of Delivery v2.

Work your whole round without signal. Today's stops load from the phone, so
a cold start in a basement still works, and every attempt you record is saved
to the handset before anything is sent.

New in this version:
- Six delivery outcomes, each asking only for the evidence it needs
- Signature capture, up to four photos, barcode scan or type
- Honest sync status: "On server" appears only once the server has it
- Two maps: your route with live position, and the whole depot
```

### The full picture

**Offline is the normal case, not the error case.** The phone's database is
the system of record until the server confirms otherwise. Evidence is written
to disk before any network call, so a force quit halfway through a submission
loses nothing: the next launch sweeps the queue and carries on.

**The sync badge never runs ahead of the truth.** "On server" is shown only
once the server has acknowledged the attempt and verified every photo it was
promised. Anything still in flight says so, and anything stuck says that too,
with a retry that does not hide what went wrong.

**Six outcomes, each with its own evidence.** Delivered to person asks for a
signature. Left in a safe place asks for a photo, because the photo is the
proof. Left with a neighbour asks for a house number and a photo. No answer,
refused and access failure each ask for what actually settles a dispute. The
rules are enforced on the phone and again on the server, so a stale build can
never write invalid evidence.

**Two maps.** Your own route with a live position that stays smooth because
GPS updates never cross into the UI layer, and the depot's full coverage with
every stop clustered on the GPU rather than one view per pin.

**Forced updates never strand evidence.** If a build is blocked from taking
new work, it can still upload everything already captured on the handset, and
the screen says how much is waiting.

### Changed in this build

- Rebuilt the interface on the brand mark and a single design language shared
  with the office dashboard.
- Signature capture: the header cleared the status bar and the Save and Clear
  actions became native, so they can no longer end up below the fold on a
  short screen.
- Map labels: cluster counts and stop sequence numbers were requesting a font
  the tile host does not serve, so they rendered as nothing.
- Stop list: an abandoned capture session no longer shows as a badge on a
  stop that was never attempted.
- Depot filters scroll instead of wrapping on narrow screens.

### Privacy and permissions

Camera, location and network only. Location is recorded per delivery attempt,
never between stops. Photo metadata is stripped on the phone before anything
is saved. `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `VIBRATE` and both external
storage permissions are explicitly removed from the merged manifest.

Android backup is switched off. This app holds delivery evidence, so it
should not be copied into cloud backup or a device to device transfer; the
server is the durable copy.

Full policy: https://18.139.240.68.sslip.io/api/privacy

### Build provenance

| | |
|---|---|
| Artifact | `app-release.aab` |
| Signed by | `CN=PoD v2, OU=Engineering, O=PoD, L=London, C=GB` |
| Key valid to | 2053 |
| Min SDK / Target SDK | see `android/build.gradle` |

Built with:

```bash
POD_V2_STORE_BUILD=1 npx expo prebuild --platform android --clean
cd android && ./gradlew bundleRelease -PpodStoreBuild=true
```

Both flags matter. The first drops the development launcher. The second turns
a missing signing keystore into a build failure instead of a silently
debug-signed bundle, which Play would reject on upload.
