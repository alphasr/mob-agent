import type { ParsedMail } from 'mailparser';

export type AuthResult = 'pass' | 'fail' | 'none' | 'other';

export interface AuthResults {
  /** Who performed the checks (e.g. "mx.google.com"); undefined when the mail carried no results. */
  checkedBy: string | undefined;
  spf: AuthResult;
  dkim: AuthResult;
  dmarc: AuthResult;
}

/**
 * Read SPF/DKIM/DMARC as judged by *our* receiving server, from the topmost
 * Authentication-Results header. Only the topmost one counts: anything further down
 * was already in the message when it arrived, so a sender can forge it.
 */
export function authResults(mail: ParsedMail): AuthResults {
  const line = mail.headerLines.find((h) => h.key === 'authentication-results')?.line;
  if (!line) return { checkedBy: undefined, spf: 'none', dkim: 'none', dmarc: 'none' };

  const value = line
    .replace(/^[^:]*:/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const checkedBy = value.split(';')[0]?.trim() || undefined;
  const found = { spf: [] as string[], dkim: [] as string[], dmarc: [] as string[] };
  for (const [, method, result] of value.matchAll(/\b(spf|dkim|dmarc)=([a-z]+)/gi)) {
    found[method!.toLowerCase() as keyof typeof found].push(result!.toLowerCase());
  }
  return { checkedBy, spf: summarize(found.spf), dkim: summarize(found.dkim), dmarc: summarize(found.dmarc) };
}

/** A message can carry several DKIM signatures; one valid signature is enough. */
function summarize(results: string[]): AuthResult {
  if (results.includes('pass')) return 'pass';
  if (results.includes('fail')) return 'fail';
  if (results.length === 0 || results.every((r) => r === 'none')) return 'none';
  return 'other';
}

export type AutomatedReason = 'auto-reply' | 'mailing-list' | 'bounce' | 'no-reply-sender';

const BULK_PRECEDENCE = new Set(['bulk', 'junk', 'list', 'auto_reply']);
const NO_REPLY_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+._-]|@)/i;

/**
 * Mail no person wrote. Answering it is how two autoresponders end up mailing each
 * other forever, so the agent never sees it. Signals per RFC 3834 plus the common
 * non-standard ones Exchange and list servers use.
 */
export function automatedReason(mail: ParsedMail, senderAddress: string): AutomatedReason | undefined {
  const autoSubmitted = headerText(mail, 'auto-submitted')?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto-reply';
  if (BULK_PRECEDENCE.has(headerText(mail, 'precedence')?.toLowerCase() ?? '')) return 'auto-reply';
  // Presence checks use the raw header lines: mailparser merges all List-* headers into one "list" entry.
  const present = new Set(mail.headerLines.map((h) => h.key));
  if (present.has('x-autoreply') || present.has('x-autorespond')) return 'auto-reply';
  if (present.has('list-id') || present.has('list-unsubscribe')) return 'mailing-list';
  if (headerText(mail, 'content-type')?.toLowerCase() === 'multipart/report') return 'bounce';
  if (NO_REPLY_SENDER.test(senderAddress)) return 'no-reply-sender';
  return undefined;
}

/** mailparser stores some headers as strings and structured ones as `{ value, params }`. */
function headerText(mail: ParsedMail, name: string): string | undefined {
  const value: unknown = mail.headers.get(name);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && value !== null && 'value' in value && typeof value.value === 'string') {
    return value.value.trim();
  }
  return undefined;
}
