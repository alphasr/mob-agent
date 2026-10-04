/** References kept on a reply: the thread root plus the most recent ones, so long threads don't grow headers forever. */
const MAX_REFERENCES = 10;

/** The id of the message that started the thread; all replies in a conversation share it. */
export function threadRoot(ids: { references: string[]; inReplyTo?: string; messageId?: string }): string | undefined {
  return ids.references[0] ?? ids.inReplyTo ?? ids.messageId;
}

/** "Re: <subject>", without stacking "Re: Re:". */
export function replySubject(subject: string | undefined): string {
  const trimmed = subject?.trim() ?? '';
  if (!trimmed) return 'Re: (no subject)';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** RFC 5322 §3.6.4: parent's References plus the parent's Message-ID, root kept when trimming. */
export function replyReferences(parentReferences: string[], parentMessageId: string | undefined): string[] {
  const all = parentMessageId ? [...parentReferences, parentMessageId] : [...parentReferences];
  if (all.length <= MAX_REFERENCES) return all;
  return [all[0]!, ...all.slice(-(MAX_REFERENCES - 1))];
}

export function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : value.split(/\s+/).filter(Boolean);
}
