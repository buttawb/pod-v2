import { Directory, File, Paths } from 'expo-file-system';
import { stripExif } from './exif';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';

/**
 * Evidence lives in the document directory, never the cache: the OS may
 * purge the cache under storage pressure, and losing proof to a cache
 * eviction is not an acceptable failure mode.
 */
const EVIDENCE_DIR_NAME = 'pod-evidence';

function evidenceDir(): Directory {
  const dir = new Directory(Paths.document, EVIDENCE_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export interface CapturedFile {
  localPath: string;
  byteSize: number;
}

/**
 * Capture order is deliberate: write the file, then the row, then advance
 * the UI. A kill between file and row leaves a harmless orphan file; the
 * reverse would leave a row pointing at evidence that never existed.
 */
export async function capturePhoto(
  clientAttemptId: string,
  photoIndex: number,
): Promise<CapturedFile | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error('Camera permission is required to capture evidence');

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    // ~300-600KB per photo keeps 150 stops x 4 photos plausible on a rural
    // connection and on a handset that is already low on storage.
    quality: 0.6,
    // Suppresses the returned metadata object only; the file itself is
    // stripped below, because that is what actually gets uploaded.
    exif: false,
  });
  if (result.canceled || result.assets.length === 0) return null;

  const source = new File(result.assets[0].uri);
  const target = new File(evidenceDir(), `${clientAttemptId}-${photoIndex}.jpg`);
  if (target.exists) target.delete();

  // Rewrite rather than move: location must not travel inside image
  // metadata, where no retention or access rule can reach it.
  target.create();
  target.write(stripExif(source.bytesSync()));
  if (source.exists) source.delete();

  if (!target.exists) throw new Error('Could not save the photo to this device');
  return { localPath: target.uri, byteSize: target.size ?? 0 };
}

export function saveSignature(clientAttemptId: string, base64Png: string): CapturedFile {
  const target = new File(evidenceDir(), `${clientAttemptId}-signature.png`);
  if (target.exists) target.delete();
  target.create();
  target.write(Uint8Array.from(atob(stripDataUrl(base64Png)), (c) => c.charCodeAt(0)));

  if (!target.exists) throw new Error('Could not save the signature to this device');
  return { localPath: target.uri, byteSize: target.size ?? 0 };
}

function stripDataUrl(base64: string): string {
  return base64.replace(/^data:image\/\w+;base64,/, '');
}

export function fileExists(uri: string): boolean {
  return new File(uri).exists;
}

export function deleteFile(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number | null;
}

/**
 * Accuracy is captured alongside the position because a 2000m fix and a 5m
 * fix are very different evidence, and a dispute needs to know which it is.
 */
export async function getCurrentFix(): Promise<Fix | null> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return null;

  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracyM: position.coords.accuracy ?? null,
    };
  } catch {
    // A fix can fail indoors; capture must never be blocked by it.
    return null;
  }
}

export function freeSpaceBytes(): number {
  return Paths.availableDiskSpace;
}
