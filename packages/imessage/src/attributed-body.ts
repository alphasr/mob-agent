/**
 * Extract the plain text from a message's `attributedBody` column.
 *
 * Since macOS Ventura, `message.text` is often NULL and the text only lives in
 * `attributedBody`: an NSAttributedString serialized with NSArchiver's "typedstream"
 * format. We don't need the attributes, just the string, which is stored right
 * after the NSString class name as:
 *
 *   ... "NSString" 0x01 0x94 0x84 0x01 '+' <length> <utf-8 bytes> ...
 *
 * where <length> is a typedstream integer: one byte for 0-127, 0x81 + int16 LE,
 * or 0x82 + int32 LE. Returns undefined if the blob doesn't look like that.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | undefined {
  if (!blob || blob.length === 0) return undefined;
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);

  const className = buf.indexOf('NSString');
  if (className === -1) return undefined;

  // The '+' (C string) type tag follows the class name within a few bytes.
  const searchFrom = className + 'NSString'.length;
  const plus = buf.indexOf(0x2b, searchFrom);
  if (plus === -1 || plus - searchFrom > 8) return undefined;

  let i = plus + 1;
  const tag = buf[i];
  if (tag === undefined) return undefined;

  let length: number;
  if (tag === 0x81) {
    if (i + 3 > buf.length) return undefined;
    length = buf.readUInt16LE(i + 1);
    i += 3;
  } else if (tag === 0x82) {
    if (i + 5 > buf.length) return undefined;
    length = buf.readUInt32LE(i + 1);
    i += 5;
  } else if (tag < 0x80) {
    length = tag;
    i += 1;
  } else {
    return undefined;
  }

  if (i + length > buf.length) return undefined;
  return buf.toString('utf8', i, i + length);
}
