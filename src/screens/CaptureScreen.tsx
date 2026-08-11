import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BottomBar, Button, Screen, colors, spacing, type } from '../ui/components';
import {
  OUTCOME_ORDER,
  OUTCOME_SPECS,
  MAX_PHOTOS_PER_ATTEMPT,
  REASON_CODES,
  validateEvidence,
  type Outcome,
} from '../domain/outcomes';
import {
  addPhoto,
  createDraft,
  finalizeAttempt,
  getPhotos,
  removePhoto,
  updateDraft,
  type PhotoRow,
} from '../db/attempts-repo';
import { capturePhoto, freeSpaceBytes, getCurrentFix, saveSignature } from '../capture/media';
import { syncEngine } from '../sync/sync-engine';
import { SignaturePad } from '../capture/SignaturePad';
import { BarcodeScanner } from '../capture/BarcodeScanner';
import { getSession } from '../auth/session';
import { APP_VERSION } from '../config';

const LOW_STORAGE_BYTES = 500 * 1024 * 1024;
const SIGNATURE_INDEX = 100;

export function CaptureScreen({ stopId, onDone }: { stopId: string; onDone: () => void }) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
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

  useEffect(() => {
    void (async () => {
      const session = await getSession();
      if (!session) return;
      const id = await createDraft({
        stopId,
        driverId: session.driverId,
        deviceId: 'device',
        appVersion: APP_VERSION,
      });
      setDraftId(id);

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
  const photoCount = photos.filter((p) => p.kind === 'photo').length;

  const violations = useMemo(() => {
    if (!outcome) return ['Choose what happened'];
    return validateEvidence(outcome, {
      hasSignature: signaturePath !== null,
      photoCount,
      reasonCode,
      neighbourHouseNumber: houseNumber.trim() || null,
    });
  }, [outcome, signaturePath, photoCount, reasonCode, houseNumber]);

  const onTakePhoto = async () => {
    if (!draftId) return;
    try {
      const nextIndex = photoCount;
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
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[type.heading, styles.section]}>What happened?</Text>
        <View style={styles.outcomeGrid}>
          {OUTCOME_ORDER.map((value) => {
            const selected = outcome === value;
            return (
              <Pressable
                key={value}
                onPress={() => {
                  setOutcome(value);
                  setReasonCode(null);
                }}
                style={[styles.outcomeTile, selected && styles.outcomeTileSelected]}
              >
                <Text style={[styles.outcomeLabel, selected && styles.outcomeLabelSelected]}>
                  {OUTCOME_SPECS[value].label}
                </Text>
                <Text style={[styles.outcomeHint, selected && styles.outcomeHintSelected]}>
                  {OUTCOME_SPECS[value].evidenceHint}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {spec ? (
          <>
            {spec.signature === 'required' ? (
              <View style={styles.section}>
                <Text style={type.heading}>Signature</Text>
                {signaturePath ? (
                  <Image source={{ uri: signaturePath }} style={styles.signaturePreview} />
                ) : null}
                <Button
                  label={signaturePath ? 'Sign again' : 'Capture signature'}
                  variant="secondary"
                  onPress={() => setShowSignature(true)}
                />
              </View>
            ) : null}

            {spec.neighbourHouseNumber === 'required' ? (
              <View style={styles.section}>
                <Text style={type.heading}>Neighbour&apos;s house number</Text>
                <TextInput
                  style={styles.input}
                  value={houseNumber}
                  onChangeText={setHouseNumber}
                  placeholder="e.g. 42"
                  placeholderTextColor={colors.textMuted}
                  inputMode="text"
                />
              </View>
            ) : null}

            {spec.reason === 'required' ? (
              <View style={styles.section}>
                <Text style={type.heading}>Reason</Text>
                <View style={styles.chips}>
                  {(REASON_CODES[outcome as string] ?? []).map((reason) => (
                    <Pressable
                      key={reason}
                      onPress={() => setReasonCode(reason)}
                      style={[styles.chip, reasonCode === reason && styles.chipSelected]}
                    >
                      <Text
                        style={[styles.chipText, reasonCode === reason && styles.chipTextSelected]}
                      >
                        {reason}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <Text style={type.heading}>
                Photos {photoCount}/{MAX_PHOTOS_PER_ATTEMPT}
                {spec.photos.min > 0 ? ' (required)' : ' (optional)'}
              </Text>
              <View style={styles.photoRow}>
                {photos
                  .filter((p) => p.kind === 'photo')
                  .map((photo) => (
                    <Pressable
                      key={photo.photo_index}
                      onLongPress={() => {
                        void removePhoto(photo.client_attempt_id, photo.photo_index).then(
                          refreshPhotos,
                        );
                      }}
                    >
                      <Image source={{ uri: photo.local_path }} style={styles.photo} />
                    </Pressable>
                  ))}
              </View>
              {photoCount < MAX_PHOTOS_PER_ATTEMPT ? (
                <Button label="Take photo" variant="secondary" onPress={() => void onTakePhoto()} />
              ) : null}
            </View>

            <View style={styles.section}>
              <Text style={type.heading}>Parcel barcode</Text>
              <TextInput
                style={styles.input}
                value={barcode}
                onChangeText={(value) => {
                  setBarcode(value);
                  setBarcodeSource('manual');
                }}
                placeholder="Scan or type"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
              />
              <Button label="Scan barcode" variant="secondary" onPress={() => setShowScanner(true)} />
            </View>

            <View style={styles.section}>
              <Text style={type.heading}>Note (optional)</Text>
              <TextInput
                style={[styles.input, styles.noteInput]}
                value={note}
                onChangeText={setNote}
                placeholder="e.g. left round back by the green bin"
                placeholderTextColor={colors.textMuted}
                multiline
              />
            </View>
          </>
        ) : null}
      </ScrollView>

      <BottomBar>
        {violations.length > 0 ? <Text style={styles.violation}>{violations[0]}</Text> : null}
        <Button
          label="Complete attempt"
          onPress={() => void submit()}
          disabled={violations.length > 0}
          loading={busy}
        />
        <Button label="Cancel" variant="secondary" onPress={onDone} />
      </BottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.lg },
  section: { gap: spacing.sm },
  outcomeGrid: { gap: spacing.sm },
  outcomeTile: {
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
    minHeight: 64,
    justifyContent: 'center',
  },
  outcomeTileSelected: { borderColor: colors.primary, backgroundColor: '#EAF2FE' },
  outcomeLabel: { fontSize: 18, fontWeight: '700', color: colors.text },
  outcomeLabelSelected: { color: colors.primary },
  outcomeHint: { fontSize: 14, color: colors.textMuted, marginTop: 2 },
  outcomeHintSelected: { color: colors.primary },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 18,
    color: colors.text,
  },
  noteInput: { minHeight: 88, paddingTop: spacing.sm, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 24,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipSelected: { borderColor: colors.primary, backgroundColor: '#EAF2FE' },
  chipText: { fontSize: 16, color: colors.text },
  chipTextSelected: { color: colors.primary, fontWeight: '700' },
  photoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  photo: { width: 76, height: 76, borderRadius: 8, backgroundColor: colors.surface },
  signaturePreview: {
    height: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.background,
  },
  violation: { color: colors.progress, fontSize: 15, fontWeight: '600' },
});
