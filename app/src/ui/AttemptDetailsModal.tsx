import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, SectionLabel, SyncBadge, colors, radius, spacing, type } from './components';
import { OUTCOME_SPECS, type Outcome } from '../domain/outcomes';
import { attemptBadge, secondsUntilRetry } from '../sync/badges';
import { PhotoUploadState, SyncState } from '../sync/state-machine';
import { getAttempt, getPhotos, type AttemptRow, type PhotoRow } from '../db/attempts-repo';
import { getStop } from '../db/stops-repo';
import { fileExists } from '../capture/media';
import { API_BASE_URL } from '../config';
import { syncEngine } from '../sync/sync-engine';

/**
 * One modal host at the root, opened by attempt id from anywhere.
 *
 * Strictly read-only. There is no edit and no delete affordance in here by
 * design: an attempt is evidence, and a screen that can display it is not a
 * screen that should be able to revise it. The only writes in the whole app
 * that touch an attempt are the capture flow and the sync engine.
 *
 * Everything is read from SQLite, never from a network response, so this opens
 * and renders in a basement exactly as it does on wifi.
 */
/**
 * What the server knows about an attempt this device never captured.
 *
 * Carried in rather than fetched here, because the caller already has it: the
 * stop screen asks the server for the stop's attempts and merges them into its
 * list. Re-requesting the same thing to open a sheet would be a second round
 * trip for data already in memory.
 */
export interface RemoteAttempt {
  outcome: string | null;
  capturedAt: string;
  receivedAt?: string;
  note?: string | null;
  reasonCode?: string | null;
  evidenceStatus?: string;
  photoCount: number;
}

interface AttemptDetailsApi {
  open: (clientAttemptId: string, remote?: RemoteAttempt) => void;
}

const AttemptDetailsContext = createContext<AttemptDetailsApi | null>(null);

export function useAttemptDetails(): AttemptDetailsApi {
  const ctx = useContext(AttemptDetailsContext);
  if (!ctx) throw new Error('useAttemptDetails used outside AttemptDetailsProvider');
  return ctx;
}

export function AttemptDetailsProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteAttempt | null>(null);
  const api = useMemo<AttemptDetailsApi>(
    () => ({
      open: (id, r) => {
        setRemote(r ?? null);
        setOpenId(id);
      },
    }),
    [],
  );

  return (
    <AttemptDetailsContext.Provider value={api}>
      {children}
      <AttemptDetailsModal
        clientAttemptId={openId}
        remote={remote}
        onClose={() => {
          setOpenId(null);
          setRemote(null);
        }}
      />
    </AttemptDetailsContext.Provider>
  );
}

const PHOTO_CHIP: Record<string, { label: string; tone: 'neutral' | 'progress' | 'good' }> = {
  [PhotoUploadState.Pending]: { label: 'Pending', tone: 'neutral' },
  [PhotoUploadState.Uploading]: { label: 'Uploading', tone: 'progress' },
  [PhotoUploadState.Uploaded]: { label: 'Uploaded', tone: 'progress' },
  [PhotoUploadState.Confirmed]: { label: 'Verified', tone: 'good' },
};

/** Below this the fix is too coarse to place a parcel at a door. */
const LOW_ACCURACY_M = 50;

function AttemptDetailsModal({
  clientAttemptId,
  remote,
  onClose,
}: {
  clientAttemptId: string | null;
  remote?: RemoteAttempt | null;
  onClose: () => void;
}) {
  const [attempt, setAttempt] = useState<AttemptRow | null>(null);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  const [viewing, setViewing] = useState<PhotoRow | null>(null);
  const insets = useSafeAreaInsets();

  const load = useCallback(async () => {
    if (!clientAttemptId) return;
    const row = await getAttempt(clientAttemptId);
    setAttempt(row);
    setPhotos(row ? await getPhotos(clientAttemptId) : []);
    setAddress(row ? ((await getStop(row.stop_id))?.address ?? null) : null);
  }, [clientAttemptId]);

  useEffect(() => {
    void load();
    // Sync moves underneath an open modal: a photo verifying while the driver
    // is looking at it should update, not sit there stale.
    return syncEngine.subscribe(() => void load());
  }, [load]);

  if (!clientAttemptId) return null;

  const outcome = attempt?.outcome as Outcome | null;
  const accuracy = attempt?.gps_accuracy_m ?? null;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.sheet}>
        {/* The modal draws under the status bar, so the top padding has to be
            the real inset. A fixed value put the title against the clock on a
            handset whose status bar is taller than the guess. */}
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {outcome ? OUTCOME_SPECS[outcome].label : 'Attempt'}
            </Text>
            {/* The address lives here rather than as another row in the card
                below: one statement of where this happened, not two. */}
            {address ? (
              <Text style={type.meta} numberOfLines={1}>
                {address}  ·  Attempt {attempt?.attempt_no ?? ''}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={onClose} accessibilityLabel="Close" hitSlop={12}>
            <Feather name="x" size={22} color={colors.textMuted} />
          </Pressable>
        </View>

        {!attempt && remote ? (
          /*
            An attempt the server holds that this device never captured, which
            is what the same driver signed in on a second handset produces.
            Everything shown came back with the stop, so it renders offline too
            once the stop itself has been read.

            The photographs are the one thing missing. They live on S3 behind a
            short-lived authenticated redirect and this sheet reads local files,
            so it reports how many the server verified rather than showing a
            broken thumbnail. Stating the count is true; implying we hold the
            images would not be.
          */
          <ScrollView contentContainerStyle={styles.body}>
            <Card style={styles.card}>
              <Row label="Captured" value={formatStamp(remote.capturedAt)} />
              <Row
                label="Reached server"
                value={remote.receivedAt ? formatStamp(remote.receivedAt) : 'Not recorded'}
              />
              {remote.reasonCode ? <Row label="Reason" value={remote.reasonCode} /> : null}
              <Row
                label="Photographs"
                value={remote.photoCount === 0 ? 'None' : `${remote.photoCount} on the server`}
              />
              {remote.evidenceStatus ? (
                <Row label="Evidence" value={remote.evidenceStatus} />
              ) : null}
            </Card>

            {remote.note ? (
              <Card style={styles.card}>
                <Row label="Note" value={remote.note} />
              </Card>
            ) : null}

            <Text style={type.meta}>
              Captured on another device. This phone holds no copy, so the
              photographs are not shown here.
            </Text>
          </ScrollView>
        ) : attempt ? (
          <ScrollView contentContainerStyle={styles.body}>
            <Card style={styles.card}>
              {/* Two clocks, always both. The gap between them is the offline
                  window, and collapsing them would hide it. */}
              <Row label="Captured" value={formatStamp(attempt.captured_at)} />
              <Row
                label="Reached server"
                value={attempt.synced_at ? formatStamp(attempt.synced_at) : 'Not yet'}
              />
              <View style={styles.badgeLine}>
                <SyncBadge
                  badge={attemptBadge(
                    attempt.sync_state as SyncState,
                    {
                      confirmed: photos.filter(
                        (p) => p.upload_state === PhotoUploadState.Confirmed,
                      ).length,
                      total: photos.length,
                    },
                    syncEngine.isOnline(),
                    secondsUntilRetry(attempt.next_retry_at),
                  )}
                />
              </View>
            </Card>

            <SectionLabel>Where</SectionLabel>
            <Card style={styles.card}>
              {attempt.lat === null || attempt.lng === null ? (
                // Never 0,0. No fix is a real answer and it is recorded as one.
                <Row label="Position" value="No GPS fix at capture" />
              ) : (
                <>
                  <Row
                    label="Position"
                    value={`${attempt.lat.toFixed(5)}, ${attempt.lng.toFixed(5)}`}
                  />
                  <Row
                    label="Accuracy"
                    value={accuracy === null ? 'Unknown' : `${Math.round(accuracy)} m`}
                  />
                  {accuracy !== null && accuracy > LOW_ACCURACY_M ? (
                    <View style={styles.warnRow}>
                      <Feather name="alert-triangle" size={14} color={colors.progress} />
                      <Text style={styles.warnText}>
                        Low accuracy: this fix is too coarse to place the parcel at a door.
                      </Text>
                    </View>
                  ) : null}
                </>
              )}
            </Card>

            <SectionLabel>What was recorded</SectionLabel>
            <Card style={styles.card}>
              {attempt.reason_code ? <Row label="Reason" value={attempt.reason_code} /> : null}
              {attempt.neighbour_house_number ? (
                <Row label="Neighbour" value={attempt.neighbour_house_number} />
              ) : null}
              {attempt.parcel_barcode ? (
                <Row
                  label="Barcode"
                  value={`${attempt.parcel_barcode}${
                    attempt.barcode_source ? ` (${attempt.barcode_source})` : ''
                  }`}
                />
              ) : null}
              {attempt.barcode_match === 0 ? (
                <View style={styles.warnRow}>
                  <Feather name="alert-triangle" size={14} color={colors.alert} />
                  <Text style={styles.mismatchText}>
                    Did not match the expected parcel
                    {attempt.barcode_override_reason
                      ? `: ${attempt.barcode_override_reason}`
                      : ''}
                  </Text>
                </View>
              ) : null}
              {attempt.barcode_match === 1 ? (
                <Row label="Barcode check" value="Matched the expected parcel" />
              ) : null}
              {attempt.retry_today === 1 ? (
                <Row label="Retry today" value="Driver is returning to this stop" />
              ) : null}
              {attempt.note ? <Row label="Note" value={attempt.note} /> : null}
            </Card>

            <SectionLabel>
              Evidence{photos.length > 0 ? ` (${photos.length})` : ''}
            </SectionLabel>
            {photos.length === 0 ? (
              <Card style={styles.card}>
                <Text style={type.meta}>No photographs or signature on this attempt.</Text>
              </Card>
            ) : (
              <View style={styles.grid}>
                {photos.map((photo) => {
                  const chip = PHOTO_CHIP[photo.upload_state] ?? {
                    label: photo.upload_state,
                    tone: 'neutral' as const,
                  };
                  return (
                    <Pressable
                      key={photo.photo_index}
                      onPress={() => setViewing(photo)}
                      accessibilityLabel={`${photo.kind}, ${chip.label}`}
                    >
                      <Image source={{ uri: resolveUri(photo) }} style={styles.thumb} />
                      <View style={styles.chipOnThumb}>
                        <SyncBadge badge={{ label: chip.label, tone: chip.tone }} />
                      </View>
                      {/* Labelled, not iconified. A pencil on a read-only
                          evidence screen reads as "edit this", which is the
                          one thing that must never be possible here. */}
                      {photo.kind === 'signature' ? (
                        <View style={styles.kindTag}>
                          <Text style={styles.kindTagText}>Signature</Text>
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </ScrollView>
        ) : (
          <View style={styles.body}>
            <Text style={type.meta}>This attempt is no longer on this device.</Text>
          </View>
        )}
      </View>

      {viewing ? <FullScreenViewer photo={viewing} onClose={() => setViewing(null)} /> : null}
    </Modal>
  );
}

/**
 * Local file first, presigned endpoint only as a fallback.
 *
 * The local copy is the same bytes that were uploaded and costs nothing to
 * show, so a driver reviewing their own work on a mobile connection should
 * never pay for it twice. The remote path exists for after the retention sweep
 * has reclaimed local storage, and it is authenticated: the bucket is private
 * and this route is the only way in.
 */
function resolveUri(photo: PhotoRow): string {
  if (photo.local_path && fileExists(photo.local_path)) return photo.local_path;
  return `${API_BASE_URL}/api/v2/media/${photo.client_attempt_id}/${photo.photo_index}`;
}

/**
 * Pinch to zoom, built on PanResponder.
 *
 * Deliberately not a new native gesture dependency: this is a viewer, and
 * adding one two days before submission would put the whole build at risk for
 * it. Two fingers scale, one finger pans once zoomed in, and a double tap
 * resets, which is the whole of what someone checking a delivery photo needs.
 */
function FullScreenViewer({ photo, onClose }: { photo: PhotoRow; onClose: () => void }) {
  /**
   * A signature needs a light backdrop; a photograph does not.
   *
   * The signature pad styles its canvas background in CSS, and CSS background
   * is not drawn into the exported bitmap, so the PNG we store is dark ink on
   * transparency. It reads fine on the white card in the grid and vanished
   * completely here, where the viewer painted black behind it: tapping a
   * signature opened what looked like a blank screen.
   *
   * Photographs stay on black, which is what makes a delivery photo easiest
   * to inspect. The backdrop follows the content rather than the screen.
   */
  const isSignature = photo.kind === 'signature';
  const backdrop = isSignature ? '#ffffff' : '#000000';
  const controlColor = isSignature ? colors.text : '#ffffff';
  const scale = useRef(new Animated.Value(1)).current;
  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const gesture = useRef({ startDistance: 0, startScale: 1, current: 1, x: 0, y: 0 });

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          gesture.current.startScale = gesture.current.current;
          gesture.current.startDistance =
            touches.length >= 2 ? distance(touches[0], touches[1]) : 0;
        },
        onPanResponderMove: (event, state) => {
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2) {
            const d = distance(touches[0], touches[1]);
            if (gesture.current.startDistance === 0) gesture.current.startDistance = d;
            const next = Math.min(
              Math.max((d / gesture.current.startDistance) * gesture.current.startScale, 1),
              6,
            );
            gesture.current.current = next;
            scale.setValue(next);
          } else if (gesture.current.current > 1) {
            // Panning is only meaningful once there is something off-screen.
            translate.setValue({ x: gesture.current.x + state.dx, y: gesture.current.y + state.dy });
          }
        },
        onPanResponderRelease: (_event, state) => {
          gesture.current.startDistance = 0;
          if (gesture.current.current > 1) {
            gesture.current.x += state.dx;
            gesture.current.y += state.dy;
          } else {
            gesture.current.x = 0;
            gesture.current.y = 0;
            translate.setValue({ x: 0, y: 0 });
          }
        },
      }),
    [scale, translate],
  );

  const reset = () => {
    gesture.current = { startDistance: 0, startScale: 1, current: 1, x: 0, y: 0 };
    scale.setValue(1);
    translate.setValue({ x: 0, y: 0 });
  };

  return (
    <Modal visible transparent={false} onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.viewer, { backgroundColor: backdrop }]} {...responder.panHandlers}>
        <Animated.Image
          source={{ uri: resolveUri(photo) }}
          resizeMode="contain"
          style={[
            styles.viewerImage,
            { transform: [...translate.getTranslateTransform(), { scale }] },
          ]}
        />
        <Pressable style={styles.viewerClose} onPress={onClose} hitSlop={12}>
          <Feather name="x" size={24} color={controlColor} />
        </Pressable>
        <Pressable style={styles.viewerReset} onPress={reset} hitSlop={12}>
          <Text style={[styles.viewerResetText, { color: controlColor }]}>Reset zoom</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function distance(a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }): number {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${date.toLocaleTimeString(
    [],
    { hour: '2-digit', minute: '2-digit' },
  )}`;
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerText: { flex: 1, gap: 2 },
  // A sheet title, not a page title: 20pt competed with the content it was
  // introducing on a screen this dense.
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.text, letterSpacing: -0.2 },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  card: { gap: spacing.sm },
  badgeLine: { flexDirection: 'row', marginTop: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  rowLabel: { width: 128, color: colors.textMuted, fontSize: 13 },
  rowValue: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  warnText: { flex: 1, color: colors.progress, fontSize: 13, fontWeight: '600' },
  mismatchText: { flex: 1, color: colors.alert, fontSize: 13, fontWeight: '600' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  thumb: {
    width: 104,
    height: 104,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipOnThumb: { position: 'absolute', bottom: 4, left: 4 },
  kindTag: {
    position: 'absolute',
    top: 6,
    right: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
  },
  kindTagText: { color: colors.primaryText, fontSize: 10, fontWeight: '700' },

  viewer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
  viewerClose: { position: 'absolute', top: 48, right: 20 },
  viewerReset: { position: 'absolute', bottom: 40, alignSelf: 'center' },
  viewerResetText: { fontSize: 14, fontWeight: '600' },
});
