import { createHash } from 'node:crypto';

/**
 * RFC 4122 UUIDv5 (SHA-1, namespaced). Implemented directly on node:crypto:
 * the uuid npm package is ESM-only which the CJS test runtime cannot load,
 * and fifteen lines beat a dependency. Output is byte-identical to the
 * reference implementation, so derived idempotency keys are stable forever.
 */
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error('namespace must be a UUID');

  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
