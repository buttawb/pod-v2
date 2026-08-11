import { stripExif } from './exif';

/** Minimal JPEG: SOI, optional APP1, a DQT-ish segment, SOS, payload, EOI. */
function buildJpeg({ withExif }: { withExif: boolean }): Uint8Array {
  const parts: number[] = [0xff, 0xd8]; // SOI

  if (withExif) {
    // APP1 carrying a fake EXIF block with something resembling a GPS tag.
    const payload = [...'Exif\0\0GPSLatitude 51.5074'].map((c) => c.charCodeAt(0));
    const length = payload.length + 2;
    parts.push(0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload);
  }

  // A non-APP1 segment that must survive untouched.
  const dqt = [0x01, 0x02, 0x03, 0x04];
  parts.push(0xff, 0xdb, 0x00, dqt.length + 2, ...dqt);

  // SOS plus entropy-coded data and EOI.
  parts.push(0xff, 0xda, 0x00, 0x03, 0x01);
  parts.push(0xaa, 0xbb, 0xcc, 0xdd);
  parts.push(0xff, 0xd9);

  return new Uint8Array(parts);
}

describe('stripExif', () => {
  it('removes the APP1 segment that carries GPS', () => {
    const withExif = buildJpeg({ withExif: true });
    expect(Buffer.from(withExif).toString('latin1')).toContain('GPSLatitude');

    const stripped = stripExif(withExif);
    expect(Buffer.from(stripped).toString('latin1')).not.toContain('GPSLatitude');
    expect(Buffer.from(stripped).toString('latin1')).not.toContain('Exif');
  });

  it('leaves an image that never had EXIF byte-for-byte identical', () => {
    const clean = buildJpeg({ withExif: false });
    expect(Array.from(stripExif(clean))).toEqual(Array.from(clean));
  });

  it('preserves the image payload after the start of scan', () => {
    const stripped = stripExif(buildJpeg({ withExif: true }));
    const bytes = Array.from(stripped);
    // The entropy-coded data and the EOI marker must be intact: this is the
    // picture itself, and stripping metadata must never touch it.
    expect(bytes.slice(-6)).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xff, 0xd9]);
    // The non-APP1 segment must survive as well.
    expect(bytes).toEqual(expect.arrayContaining([0xff, 0xdb, 0x01, 0x02, 0x03, 0x04]));
  });

  it('returns non-JPEG input untouched rather than corrupting it', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(Array.from(stripExif(png))).toEqual(Array.from(png));
  });

  it('refuses to rewrite a malformed segment length', () => {
    // Declares a segment far longer than the buffer.
    const malformed = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01, 0x02]);
    expect(Array.from(stripExif(malformed))).toEqual(Array.from(malformed));
  });
});
