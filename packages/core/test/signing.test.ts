import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSignature, signBody, verifyWebhook } from '../src/index.ts';

const SECRET = 's'.repeat(32);

describe('request signing', () => {
  it('verifies a fresh signature over the exact body', () => {
    const header = signBody(SECRET, '{"a":1}');
    assert.equal(checkSignature(SECRET, '{"a":1}', header), 'valid');
    assert.equal(checkSignature(SECRET, Buffer.from('{"a":1}'), header), 'valid', 'bytes and strings agree');
    assert.equal(verifyWebhook(SECRET, '{"a":1}', header), true);
  });

  it('rejects tampering, wrong secrets, and garbage', () => {
    const header = signBody(SECRET, '{"a":1}');
    assert.equal(checkSignature(SECRET, '{"a":2}', header), 'mismatch');
    assert.equal(checkSignature('x'.repeat(32), '{"a":1}', header), 'mismatch');
    assert.equal(checkSignature(SECRET, '{}', null), 'missing');
    assert.equal(checkSignature(SECRET, '{}', 't=abc,v1=00'), 'malformed');
    assert.equal(checkSignature(SECRET, '{}', 'v1=' + '0'.repeat(64)), 'malformed');
  });

  it('rejects stale and future timestamps, including a re-timestamped signature', () => {
    const now = 1_790_000_000;
    const old = signBody(SECRET, '{}', now - 301);
    assert.equal(checkSignature(SECRET, '{}', old, now), 'expired');
    assert.equal(checkSignature(SECRET, '{}', signBody(SECRET, '{}', now + 301), now), 'expired');
    assert.equal(checkSignature(SECRET, '{}', signBody(SECRET, '{}', now - 299), now), 'valid');
    // The timestamp is inside the MAC: swapping in a fresh one breaks the signature.
    const forged = old.replace(`t=${now - 301}`, `t=${now}`);
    assert.equal(checkSignature(SECRET, '{}', forged, now), 'mismatch');
  });
});
