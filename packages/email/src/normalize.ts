import type { Attachment, InboundMessage } from '@textagent/core';
import type { ParsedMail } from 'mailparser';
import { authResults, automatedReason } from './headers.ts';
import type { AuthResults, AutomatedReason } from './headers.ts';
import { stripQuoted } from './quote.ts';
import { asList, threadRoot } from './threading.ts';

/** What `InboundMessage.raw` holds for email, and what replies are built from. */
export interface EmailRaw {
  messageId: string | undefined;
  references: string[];
  subject: string;
  auth: AuthResults;
  /** The whole body, including quoted history and signature. */
  fullText: string;
}

export type EmailSkipReason = AutomatedReason | 'own-address' | 'no-sender' | 'dmarc-fail' | 'empty';

export type NormalizeResult = { message: InboundMessage } | { skip: EmailSkipReason; from?: string };

export function normalizeEmail(mail: ParsedMail, options: { ownAddress: string; fallbackId: string }): NormalizeResult {
  const from = mail.from?.value[0];
  const address = from?.address?.toLowerCase();
  if (!address) return { skip: 'no-sender' };
  if (address === options.ownAddress.toLowerCase()) return { skip: 'own-address', from: address };

  const automated = automatedReason(mail, address);
  if (automated) return { skip: automated, from: address };

  const auth = authResults(mail);
  // The domain owner published a policy and this mail failed it: the From address is forged.
  if (auth.dmarc === 'fail') return { skip: 'dmarc-fail', from: address };

  // mailparser derives `text` from the HTML part when a message has no plain-text part.
  const fullText = (mail.text ?? '').trim();
  const attachments: Attachment[] = mail.attachments
    .filter((a) => a.contentDisposition !== 'inline')
    .map((a) => ({
      kind: kindOf(a.contentType),
      mimeType: a.contentType,
      ...(a.filename && { filename: a.filename }),
    }));
  const text = stripQuoted(fullText);
  if (!text && attachments.length === 0) return { skip: 'empty', from: address };

  const references = asList(mail.references);
  const messageId = mail.messageId;
  const subject = mail.subject ?? '';
  const raw: EmailRaw = { messageId, references, subject, auth, fullText };

  return {
    message: {
      id: messageId ?? options.fallbackId,
      channel: 'email',
      thread: {
        id:
          threadRoot({
            references,
            ...(mail.inReplyTo && { inReplyTo: mail.inReplyTo }),
            ...(messageId && { messageId }),
          }) ?? options.fallbackId,
        channel: 'email',
        isGroup: false,
        subject,
      },
      sender: { id: address, ...(from?.name && { name: from.name }) },
      text,
      attachments,
      timestamp: mail.date ?? new Date(),
      raw,
    },
  };
}

function kindOf(mime: string): Attachment['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}
