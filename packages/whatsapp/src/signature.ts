import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Check Meta's `X-Hub-Signature-256` header: "sha256=" + hex HMAC-SHA256 of the raw
 * request body, keyed with the app secret. Must run on the exact bytes received,
 * before the body is parsed or trusted.
 */
export function isValidSignature(rawBody: Uint8Array, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  // timingSafeEqual throws on length mismatch; a wrong length is simply invalid.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Constant-time string comparison; hashing first makes the lengths equal. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
