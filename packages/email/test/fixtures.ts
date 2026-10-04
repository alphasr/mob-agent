/** Build a raw RFC 5322 message. Header order is preserved, which matters for Authentication-Results. */
export function eml(headers: Array<[string, string]>, body: string): Buffer {
  const head = headers.map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return Buffer.from(`${head}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`);
}

export const AGENT = 'agent@acme.test';

/** A person's reply in an existing thread, as Gmail would deliver it. */
export function personReply(
  overrides: { from?: string; messageId?: string; body?: string; extra?: Array<[string, string]> } = {},
) {
  return eml(
    [
      [
        'Authentication-Results',
        'mx.acme.test; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com',
      ],
      ['From', overrides.from ?? 'Ada Lovelace <ada@example.com>'],
      ['To', AGENT],
      ['Subject', 'Re: Invoice #42'],
      ['Date', 'Sun, 04 Oct 2026 12:00:00 +0000'],
      ['Message-ID', overrides.messageId ?? '<reply-2@example.com>'],
      ['In-Reply-To', '<agent-1@acme.test>'],
      ['References', '<root-0@example.com> <agent-1@acme.test>'],
      ...(overrides.extra ?? []),
      ['Content-Type', 'text/plain; charset=utf-8'],
    ],
    overrides.body ??
      [
        'Yes, please resend it to my work address.',
        '',
        'On Sun, Oct 4, 2026 at 11:00 AM Acme Support <agent@acme.test>',
        'wrote:',
        '> Would you like the invoice resent?',
        '> Thanks, Acme',
      ].join('\n'),
  );
}
