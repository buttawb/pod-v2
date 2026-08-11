/**
 * Opaque keyset cursor: (timestamp, id) pair, base64url-encoded.
 * Keyset over OFFSET everywhere: constant cost at any depth against 14M+
 * rows, and stable under concurrent inserts (no skipped/duplicated rows).
 */
export interface Keyset {
  ts: string; // ISO timestamp of the last row seen
  id: string; // uuid tiebreak
}

export function encodeCursor(keyset: Keyset): string {
  return Buffer.from(JSON.stringify(keyset), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Keyset | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Keyset).ts === 'string' &&
      typeof (parsed as Keyset).id === 'string' &&
      !Number.isNaN(Date.parse((parsed as Keyset).ts))
    ) {
      return parsed as Keyset;
    }
    return null;
  } catch {
    return null;
  }
}
