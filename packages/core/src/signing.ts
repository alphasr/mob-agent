import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying textagent's request signatures, in both directions. */
export const SIGNATURE_HEADER = 'textagent-signature';

/** How far a signature's timestamp may drift from now. Also how long a replay must be remembered. */
export const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Sign a request body: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
 * The timestamp is inside the MAC, so a captured request stops working after the tolerance window.
 */
export function signBody(secret: string, body: string | Uint8Array, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${mac(secret, timestamp, body).toString('hex')}`;
}

export type SignatureCheck = 'valid' | 'missing' | 'malformed' | 'expired' | 'mismatch';

export function checkSignature(
  secret: string,
  body: string | Uint8Array,
  header: string | null | undefined,
  now = Math.floor(Date.now() / 1000),
): SignatureCheck {
  if (!header) return 'missing';
  const parts = new Map(
    header.split(',').map((part) => {
      const i = part.indexOf('=');
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1') ?? '';
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return 'malformed';
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SEC) return 'expired';
  return timingSafeEqual(Buffer.from(signature, 'hex'), mac(secret, timestamp, body)) ? 'valid' : 'mismatch';
}

/** For receivers written in Node: true only for a correctly signed, fresh request. Pass the raw body. */
export function verifyWebhook(
  secret: string,
  rawBody: string | Uint8Array,
  header: string | null | undefined,
): boolean {
  return checkSignature(secret, rawBody, header) === 'valid';
}

function mac(secret: string, timestamp: number, body: string | Uint8Array): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
}
