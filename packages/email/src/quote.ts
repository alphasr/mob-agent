/**
 * Where quoted history or a signature begins. Covers Gmail/Apple Mail ("On … wrote:",
 * which Gmail wraps onto two lines when the sender's name is long), Outlook's separators,
 * the standard "-- " signature delimiter, and mobile sign-offs. English only for now.
 */
const CUT_MARKERS = [
  /^[ \t]*On\b[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:[ \t]*$/m,
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*$/im,
  /^[ \t]*_{10,}[ \t]*$/m,
  /^[ \t]*From:[^\n]+\n[ \t]*(?:Sent|Date):/im,
  /^-- ?$/m,
  /^[ \t]*Sent from my [^\n]+$/im,
];

/** The new text a person wrote, without quoted history or signature. */
export function stripQuoted(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  let cut = normalized.length;
  for (const marker of CUT_MARKERS) {
    const index = normalized.search(marker);
    if (index !== -1 && index < cut) cut = index;
  }
  const kept = normalized
    .slice(0, cut)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim();
  // Someone who only replied inline between quoted lines would be left with nothing; keep it all then.
  return kept || normalized.trim();
}
