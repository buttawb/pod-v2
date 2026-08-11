/**
 * expo-image-picker's `exif: false` only suppresses the metadata object it
 * returns to JavaScript. The file it writes still carries the camera's EXIF,
 * GPS tags included, and those bytes are what we upload and what the office
 * later downloads. Location has to live in governed columns, not inside an
 * image where nothing can reach it, so APP1 is removed here.
 *
 * Deliberately a pure function over bytes: no native modules, so it is
 * unit-tested off-device.
 */
export function stripExif(bytes: Uint8Array): Uint8Array {
  // Not a JPEG (SOI marker absent): never rewrite bytes we do not understand.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;

  const keep: Array<[number, number]> = [[0, 2]];
  let i = 2;

  while (i + 3 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    // Start of scan: entropy-coded image data runs to the end of the file.
    if (marker === 0xda) break;

    const end = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    // Malformed length: leave the evidence exactly as captured.
    if (end <= i || end > bytes.length) return bytes;

    // APP1 carries both EXIF (with GPS) and XMP.
    if (marker !== 0xe1) keep.push([i, end]);
    i = end;
  }
  keep.push([i, bytes.length]);

  const out = new Uint8Array(keep.reduce((total, [start, end]) => total + (end - start), 0));
  let offset = 0;
  for (const [start, end] of keep) {
    out.set(bytes.subarray(start, end), offset);
    offset += end - start;
  }
  return out;
}
