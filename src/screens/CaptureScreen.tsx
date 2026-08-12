import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  BottomBar,
  Button,
  Card,
  Chip,
  Field,
  Input,
  PageHeader,
  Screen,
  SectionLabel,
  useEdgePadding,
  CONTENT_MAX_WIDTH,
  colors,
  radius,
  spacing,
  type,
} from '../ui/components';
import {
  OUTCOME_ORDER,
  OUTCOME_SPECS,
  MAX_PHOTOS_PER_ATTEMPT,
  REASON_CODES,
  validateEvidence,
  Outcome,
  type Outcome as OutcomeValue,
} from '../domain/outcomes';
import {
  addPhoto,
  createDraft,
  finalizeAttempt,
  getDraftForStop,
  getPhotos,
  removePhoto,
  updateDraft,
  type PhotoRow,
} from '../db/attempts-repo';
import { hydrateDraft } from '../sync/drafts';
import { capturePhoto, deleteFile, freeSpaceBytes, getCurrentFix, saveSignature } from '../capture/media';
import { syncEngine } from '../sync/sync-engine';
import { SignaturePad } from '../capture/SignaturePad';
import { BarcodeScanner } from '../capture/BarcodeScanner';
import { getSession } from '../auth/session';
import { APP_VERSION } from '../config';

const LOW_STORAGE_BYTES = 500 * 1024 * 1024;
const SIGNATURE_INDEX = 100;

/**
 * Long enough that typing is not a commit per keystroke, short enough that a
 * force-quit costs at most a word. The AppState flush covers the window.
 */
const DRAFT_SAVE_DEBOUNCE_MS = 600;

/** One glyph per outcome so the tile is recognisable before it is read. */
const OUTCOME_ICONS: Record<OutcomeValue, keyof typeof Feather.glyphMap> = {
  [Outcome.DeliveredToPerson]: 'user-check',
  [Outcome.LeftWithNeighbour]: 'home',
  [Outcome.LeftSafePlace]: 'package',
  [Outcome.NoAnswerCarded]: 'mail',
  [Outcome.Refused]: 'x-circle',
  [Outcome.AccessFailure]: 'lock',
};

export function CaptureScreen({ stopId, onDone }: { stopId: string; onDone: () => void }) {
  const edge = useEdgePadding();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeValue | null>(null);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [signaturePath, setSignaturePath] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [houseNumber, setHouseNumber] = useState('');
  const [note, setNote] = useState('');
  const [barcode, setBarcode] = useState('');
  const [barcodeSource, setBarcodeSource] = useState<'scanned' | 'manual'>('manual');
  const [showSignature, setShowSignature] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void (async () => {
      const session = await getSession();
      if (!session) return;

      // Resume before creating. A force-quit mid-capture leaves the row and
      // its photo files on disk untouched; minting a fresh draft here is what
      // made that work unreachable while it sat there.
      const existing = await getDraftForStop(stopId, session.driverId);
      if (existing) {
        const snapshot = hydrateDraft(existing, await getPhotos(existing.client_attempt_id));
        setDraftId(snapshot.clientAttemptId);
        // An outcome this build no longer knows about must not be silently
        // re-selected: it would drive the wrong evidence rules.
        setOutcome(
          snapshot.outcome && snapshot.outcome in OUTCOME_SPECS
            ? (snapshot.outcome as OutcomeValue)
            : null,
        );
        setReasonCode(snapshot.reasonCode);
        setHouseNumber(snapshot.neighbourHouseNumber);
        setNote(snapshot.note);
        setBarcode(snapshot.parcelBarcode);
        setBarcodeSource(snapshot.barcodeSource);
        setSignaturePath(snapshot.signaturePath);
        setPhotos(snapshot.photos);
      } else {
        setDraftId(
          await createDraft({
            stopId,
            driverId: session.driverId,
            deviceId: 'device',
            appVersion: APP_VERSION,
          }),
        );
      }
      setHydrated(true);

      if (freeSpaceBytes() < LOW_STORAGE_BYTES) {
        Alert.alert('Storage is low', 'Free some space soon so evidence can still be saved.');
      }
    })();
  }, [stopId]);

  const refreshPhotos = useCallback(async () => {
    if (!draftId) return;
    setPhotos(await getPhotos(draftId));
  }, [draftId]);

  const spec = outcome ? OUTCOME_SPECS[outcome] : null;
  const photoRows = photos.filter((p) => p.kind === 'photo');
  const photoCount = photoRows.length;

  /**
   * Lowest FREE index, never the count. After a delete the indexes are
   * sparse, so reusing the count would silently overwrite an existing
   * photo's file and row - destroying captured evidence with no warning.
   */
  const nextPhotoIndex = (): number => {
    const used = new Set(photoRows.map((p) => p.photo_index));
    for (let i = 0; i < MAX_PHOTOS_PER_ATTEMPT; i += 1) {
      if (!used.has(i)) return i;
    }
    return -1;
  };

  const violations = useMemo(() => {
    if (!outcome) return ['Choose what happened'];
    return validateEvidence(outcome, {
      hasSignature: signaturePath !== null,
      photoCount,
      reasonCode,
      neighbourHouseNumber: houseNumber.trim() || null,
    });
  }, [outcome, signaturePath, photoCount, reasonCode, houseNumber]);

  const draftFields = useMemo(
    () => ({
      outcome,
      reason_code: reasonCode,
      neighbour_house_number: houseNumber.trim() || null,
      note: note.trim() || null,
      parcel_barcode: barcode.trim() || null,
      barcode_source: barcode.trim() ? barcodeSource : null,
    }),
    [outcome, reasonCode, houseNumber, note, barcode, barcodeSource],
  );

  // Read outside the render cycle by the background flush, which would
  // otherwise capture whatever the closure held when the listener was bound.
  const latestFields = useRef(draftFields);
  latestFields.current = draftFields;

  const flushDraft = useCallback(async () => {
    // The `hydrated` gate is what stops the first empty render from
    // overwriting the draft that was just restored into it.
    if (!draftId || !hydrated) return;
    await updateDraft(draftId, latestFields.current);
  }, [draftId, hydrated]);

  useEffect(() => {
    if (!draftId || !hydrated) return;
    const timer = setTimeout(() => void flushDraft(), DRAFT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftFields, draftId, hydrated, flushDraft]);

  useEffect(() => {
    // A force-quit is preceded by a background transition on both platforms,
    // so this is the last reliable moment to get the debounce window down.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void flushDraft();
    });
    return () => subscription.remove();
  }, [flushDraft]);

  const onTakePhoto = async () => {
    if (!draftId) return;
    try {
      const nextIndex = nextPhotoIndex();
      if (nextIndex < 0) return;
      const file = await capturePhoto(draftId, nextIndex);
      if (!file) return;
      await addPhoto({
        clientAttemptId: draftId,
        photoIndex: nextIndex,
        kind: 'photo',
        localPath: file.localPath,
        byteSize: file.byteSize,
      });
      await refreshPhotos();
    } catch (err) {
      // A failed write must never look like a successful capture.
      Alert.alert('Could not save photo', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const onSignature = async (base64: string) => {
    if (!draftId) return;
    setShowSignature(false);
    try {
      const file = await saveSignature(draftId, base64);
      await addPhoto({
        clientAttemptId: draftId,
        photoIndex: SIGNATURE_INDEX,
        kind: 'signature',
        localPath: file.localPath,
        byteSize: file.byteSize,
      });
      setSignaturePath(file.localPath);
      await updateDraft(draftId, { signature_path: file.localPath });
      await refreshPhotos();
    } catch (err) {
      Alert.alert('Could not save signature', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const submit = async () => {
    if (!draftId || !outcome || violations.length > 0) return;
    setBusy(true);
    try {
      const fix = await getCurrentFix();
      await updateDraft(draftId, {
        outcome,
        reason_code: reasonCode,
        neighbour_house_number: houseNumber.trim() || null,
        note: note.trim() || null,
        parcel_barcode: barcode.trim() || null,
        barcode_source: barcode.trim() ? barcodeSource : null,
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
        gps_accuracy_m: fix?.accuracyM ?? null,
      });

      // One conditioned UPDATE, committed before we navigate: a double tap
      // is a no-op, and a kill right after this still uploads on next launch.
      const finalized = await finalizeAttempt(draftId);
      if (!finalized) {
        Alert.alert('Already saved', 'This attempt has already been recorded.');
      }
      void syncEngine.kick();
      onDone();
    } finally {
      setBusy(false);
    }
  };

  if (showSignature) {
    return <SignaturePad onDone={(b64) => void onSignature(b64)} onCancel={() => setShowSignature(false)} />;
  }
  if (showScanner) {
    return (
      <BarcodeScanner
        onScanned={(value) => {
          setBarcode(value);
          setBarcodeSource('scanned');
          setShowScanner(false);
        }}
        onCancel={() => setShowScanner(false)}
      />
    );
  }

  return (
    <Screen>
      <PageHeader title="Record attempt" subtitle="Saved to this phone first" onBack={onDone} />

      <ScrollView contentContainerStyle={[styles.content, edge]} keyboardShouldPersistTaps="handled">
        <SectionLabel>What happened?</SectionLabel>
        <View style={styles.outcomeGrid}>
          {OUTCOME_ORDER.map((value) => {
            const selected = outcome === value;
            return (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => {
                  setOutcome(value);
                  setReasonCode(null);
                }}
                style={({ pressed }) => [
                  styles.outcomeTile,
                  selected && styles.outcomeTileSelected,
                  pressed && !selected && { backgroundColor: colors.secondary },
                ]}
              >
                <View style={[styles.outcomeIcon, selected && styles.outcomeIconSelected]}>
                  <Feather
                    name={OUTCOME_ICONS[value]}
                    size={18}
                    color={selected ? colors.primaryText : colors.textMuted}
                  />
                </View>
                <View style={styles.outcomeText}>
                  <Text style={styles.outcomeLabel}>{OUTCOME_SPECS[value].label}</Text>
                  <Text style={type.meta}>{OUTCOME_SPECS[value].evidenceHint}</Text>
                </View>
                {selected ? <Feather name="check-circle" size={20} color={colors.primary} /> : null}
              </Pressable>
            );
          })}
        </View>

        {spec ? (
          <>
            <SectionLabel>Evidence</SectionLabel>

            {spec.signature === 'required' ? (
              <Card style={styles.section}>
                <Text style={type.subheading}>Signature</Text>
                {signaturePath ? (
                  <Image source={{ uri: signaturePath }} style={styles.signaturePreview} />
                ) : null}
                <Button
                  label={signaturePath ? 'Sign again' : 'Capture signature'}
                  icon="edit-3"
                  variant="secondary"
                  onPress={() => setShowSignature(true)}
                />
              </Card>
            ) : null}

            {spec.neighbourHouseNumber === 'required' ? (
              <Card style={styles.section}>
                <Field label="Neighbour's house number">
                  <Input
                    value={houseNumber}
                    onChangeText={setHouseNumber}
                    placeholder="e.g. 42"
                    inputMode="text"
                  />
                </Field>
              </Card>
            ) : null}

            {spec.reason === 'required' ? (
              <Card style={styles.section}>
                <Text style={type.subheading}>Reason</Text>
                <View style={styles.chips}>
                  {(REASON_CODES[outcome as string] ?? []).map((reason) => (
                    <Chip
                      key={reason}
                      label={reason}
                      selected={reasonCode === reason}
                      onPress={() => setReasonCode(reason)}
                    />
                  ))}
                </View>
              </Card>
            ) : null}

            <Card style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={type.subheading}>Photos</Text>
                <Text style={type.meta}>
                  {photoCount}/{MAX_PHOTOS_PER_ATTEMPT}
                  {spec.photos.min > 0 ? '  ·  required' : '  ·  optional'}
                </Text>
              </View>

              {photoCount > 0 ? (
                <View style={styles.photoRow}>
                  {photoRows.map((photo) => (
                    <Pressable
                      key={photo.photo_index}
                      accessibilityLabel="Photo, long press to remove"
                      onLongPress={() => {
                        // Row and file go together: a row-only delete would
                        // leave the JPEG orphaned on the device forever.
                        void removePhoto(photo.client_attempt_id, photo.photo_index)
                          .then(() => deleteFile(photo.local_path))
                          .then(refreshPhotos);
                      }}
                    >
                      <Image source={{ uri: photo.local_path }} style={styles.photo} />
                      <View style={styles.photoRemove}>
                        <Feather name="x" size={11} color={colors.primaryText} />
                      </View>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              {photoCount < MAX_PHOTOS_PER_ATTEMPT ? (
                <Button
                  label="Take photo"
                  icon="camera"
                  variant="secondary"
                  onPress={() => void onTakePhoto()}
                />
              ) : null}
              {photoCount > 0 ? <Text style={type.meta}>Long press a photo to remove it.</Text> : null}
            </Card>

            <SectionLabel>Details</SectionLabel>

            <Card style={styles.section}>
              <Field label="Parcel barcode">
                <Input
                  value={barcode}
                  onChangeText={(value) => {
                    setBarcode(value);
                    setBarcodeSource('manual');
                  }}
                  placeholder="Scan or type"
                  autoCapitalize="characters"
                />
              </Field>
              <Button
                label="Scan barcode"
                icon="maximize"
                variant="secondary"
                onPress={() => setShowScanner(true)}
              />
            </Card>

            <Card style={styles.section}>
              <Field label="Note (optional)">
                <Input
                  value={note}
                  onChangeText={setNote}
                  placeholder="e.g. left round back by the green bin"
                  multiline
                />
              </Field>
            </Card>
          </>
        ) : null}
      </ScrollView>

      <BottomBar>
        {violations.length > 0 ? (
          <View style={styles.violation}>
            <Feather name="info" size={15} color={colors.progress} />
            <Text style={styles.violationText}>{violations[0]}</Text>
          </View>
        ) : null}
        <Button
          label="Complete attempt"
          icon="check"
          onPress={() => void submit()}
          disabled={violations.length > 0}
          loading={busy}
        />
      </BottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  section: { gap: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  outcomeGrid: { gap: spacing.sm },
  outcomeTile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xl,
    padding: spacing.md,
    minHeight: 68,
  },
  outcomeTileSelected: { borderColor: colors.primary, backgroundColor: colors.background },
  outcomeIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outcomeIconSelected: { backgroundColor: colors.primary },
  outcomeText: { flex: 1, gap: 2 },
  outcomeLabel: { fontSize: 16, fontWeight: '600', color: colors.text },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  photoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  photo: {
    width: 76,
    height: 76,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  photoRemove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 20,
    height: 20,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.card,
  },
  signaturePreview: {
    height: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.background,
  },

  violation: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  violationText: { flex: 1, color: colors.progress, fontSize: 14, fontWeight: '600' },
});
