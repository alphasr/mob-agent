// Preferred break points, best first. A break is only taken if it keeps the
// chunk at least half full, so one early blank line doesn't produce a tiny message.
const SOFT_BREAKS = ['\n\n', '\n', '. '];

/** Split text into chunks no longer than `max`, breaking at paragraph, line, sentence, then word boundaries. */
export function splitText(text: string, max: number): string[] {
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError(`max must be a positive integer, got ${max}`);
  }
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;

    for (const sep of SOFT_BREAKS) {
      const i = window.lastIndexOf(sep);
      if (i > max / 2) {
        cut = sep === '. ' ? i + 1 : i; // keep the period with its sentence
        break;
      }
    }
    if (cut === -1) {
      const space = window.lastIndexOf(' ');
      cut = space > 0 ? space : max;
    }
    // Never cut an emoji or other astral character in half.
    if (cut === max && isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
