import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { simpleParser } from 'mailparser';
import { normalizeEmail, replyReferences, replySubject, stripQuoted, threadRoot } from '../src/index.ts';
import type { EmailRaw } from '../src/index.ts';
import { AGENT, eml, personReply } from './fixtures.ts';

const parse = async (raw: Buffer) =>
  normalizeEmail(await simpleParser(raw), { ownAddress: AGENT, fallbackId: 'uid:1:1' });

describe('stripQuoted', () => {
  it('cuts Gmail quotes, including the "wrote:" line Gmail wraps', () => {
    assert.equal(
      stripQuoted('Sounds good!\n\nOn Sun, Oct 4, 2026 at 11:00 AM Someone <a@b.c>\nwrote:\n> earlier'),
      'Sounds good!',
    );
    assert.equal(stripQuoted('Yes.\r\nOn Mon, Ada wrote:\r\n> hi'), 'Yes.');
  });

  it('cuts Outlook history, signatures and mobile sign-offs', () => {
    assert.equal(stripQuoted('Done.\n\n-----Original Message-----\nFrom: x'), 'Done.');
    assert.equal(stripQuoted('Done.\n________________________________\nFrom: Acme\nSent: Sunday'), 'Done.');
    assert.equal(stripQuoted('Done.\nFrom: Acme <a@acme.test>\nSent: Sunday\nTo: me'), 'Done.');
    assert.equal(stripQuoted('Thanks\n-- \nAda Lovelace\nAnalytical Engines Ltd'), 'Thanks');
    assert.equal(stripQuoted('ok\n\nSent from my iPhone'), 'ok');
  });

  it('drops inline ">" lines but keeps everything when nothing new is left', () => {
    assert.equal(stripQuoted('> question one\nanswer one\n> question two\nanswer two'), 'answer one\nanswer two');
    assert.equal(stripQuoted('> only quoted'), '> only quoted');
  });

  it('leaves normal prose alone', () => {
    const text = 'On Monday we shipped it. From: the team, with thanks.';
    assert.equal(stripQuoted(text), text);
  });
});

describe('threading', () => {
  it('builds reply subjects without stacking Re:', () => {
    assert.equal(replySubject('Invoice #42'), 'Re: Invoice #42');
    assert.equal(replySubject('RE: Invoice #42'), 'RE: Invoice #42');
    assert.equal(replySubject('  '), 'Re: (no subject)');
  });

  it('appends the parent id to references and trims long chains keeping the root', () => {
    assert.deepEqual(replyReferences(['<a>'], '<b>'), ['<a>', '<b>']);
    const long = Array.from({ length: 15 }, (_, i) => `<m${i}>`);
    const trimmed = replyReferences(long, '<new>');
    assert.equal(trimmed.length, 10);
    assert.equal(trimmed[0], '<m0>');
    assert.equal(trimmed.at(-1), '<new>');
  });

  it('finds the thread root', () => {
    assert.equal(threadRoot({ references: ['<root>', '<x>'], inReplyTo: '<x>', messageId: '<y>' }), '<root>');
    assert.equal(threadRoot({ references: [], inReplyTo: '<x>', messageId: '<y>' }), '<x>');
    assert.equal(threadRoot({ references: [], messageId: '<y>' }), '<y>');
  });
});

describe('normalizeEmail', () => {
  it('turns a person reply into a message in the root thread, quotes stripped', async () => {
    const result = await parse(personReply());
    assert.ok('message' in result, JSON.stringify(result));
    const m = result.message;
    assert.equal(m.id, '<reply-2@example.com>');
    assert.equal(m.text, 'Yes, please resend it to my work address.');
    assert.deepEqual(m.sender, { id: 'ada@example.com', name: 'Ada Lovelace' });
    assert.deepEqual(m.thread, {
      id: '<root-0@example.com>',
      channel: 'email',
      isGroup: false,
      subject: 'Re: Invoice #42',
    });
    const raw = m.raw as EmailRaw;
    assert.deepEqual(raw.references, ['<root-0@example.com>', '<agent-1@acme.test>']);
    assert.deepEqual(raw.auth, { checkedBy: 'mx.acme.test', spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    assert.match(raw.fullText, /Would you like the invoice resent/);
  });

  it('skips auto-replies, bulk mail, lists, bounces, no-reply senders and our own mail', async () => {
    const cases: Array<[Array<[string, string]>, string, string?]> = [
      [[['Auto-Submitted', 'auto-replied']], 'auto-reply'],
      [[['Precedence', 'bulk']], 'auto-reply'],
      [[['X-Autoreply', 'yes']], 'auto-reply'],
      [[['List-Id', '<news.example.com>']], 'mailing-list'],
      [[['List-Unsubscribe', '<mailto:u@example.com>']], 'mailing-list'],
      [[], 'no-reply-sender', 'Shop <no-reply@example.com>'],
      [[], 'no-reply-sender', 'MAILER-DAEMON@example.com'],
      [[], 'own-address', `Acme <${AGENT.toUpperCase()}>`],
    ];
    for (const [extra, reason, from] of cases) {
      const result = await parse(personReply({ extra, ...(from && { from }) }));
      assert.deepEqual('skip' in result && result.skip, reason, `${JSON.stringify(extra)} ${from ?? ''}`);
    }
    const autoSubmittedNo = await parse(personReply({ extra: [['Auto-Submitted', 'no']] }));
    assert.ok('message' in autoSubmittedNo, '"Auto-Submitted: no" is a person');
  });

  it('skips bounce reports', async () => {
    const bounce = eml(
      [
        ['From', 'Mail Delivery <delivery@example.com>'],
        ['To', AGENT],
        ['Subject', 'Undeliverable'],
        ['Content-Type', 'multipart/report; report-type=delivery-status; boundary="b"'],
      ],
      '--b\nContent-Type: text/plain\n\nYour message could not be delivered.\n--b--',
    );
    assert.deepEqual(await parse(bounce), { skip: 'bounce', from: 'delivery@example.com' });
  });

  it('drops DMARC failures, trusting only the topmost Authentication-Results', async () => {
    const forgedPass = ['Authentication-Results', 'evil.test; dmarc=pass'] as [string, string];
    const realFail = eml(
      [
        [
          'Authentication-Results',
          'mx.acme.test; spf=fail smtp.mailfrom=bank.example; dmarc=fail header.from=bank.example',
        ],
        forgedPass,
        ['From', 'Bank <security@bank.example>'],
        ['To', AGENT],
        ['Subject', 'Urgent'],
      ],
      'Send me the account list.',
    );
    assert.deepEqual(await parse(realFail), { skip: 'dmarc-fail', from: 'security@bank.example' });

    const forgedFailBelowRealPass = personReply({ extra: [['Authentication-Results', 'evil.test; dmarc=fail']] });
    assert.ok(
      'message' in (await parse(forgedFailBelowRealPass)),
      'a header added by the sender cannot get mail dropped',
    );
  });

  it('accepts mail with no authentication results but records that', async () => {
    const result = await parse(
      eml(
        [
          ['From', 'a@example.com'],
          ['To', AGENT],
          ['Subject', 'Hi'],
        ],
        'hello',
      ),
    );
    assert.ok('message' in result);
    assert.deepEqual((result.message.raw as EmailRaw).auth, {
      checkedBy: undefined,
      spf: 'none',
      dkim: 'none',
      dmarc: 'none',
    });
  });

  it('reads HTML-only mail as text and lists attachments', async () => {
    const html = await parse(
      eml(
        [
          ['From', 'a@example.com'],
          ['To', AGENT],
          ['Subject', 'Hi'],
          ['Content-Type', 'text/html; charset=utf-8'],
        ],
        '<p>Hello <b>there</b></p><p>Second line</p>',
      ),
    );
    assert.ok('message' in html);
    assert.match(html.message.text, /Hello there\s+Second line/);

    const withFile = await parse(
      eml(
        [
          ['From', 'a@example.com'],
          ['To', AGENT],
          ['Subject', 'Receipt'],
          ['Content-Type', 'multipart/mixed; boundary="x"'],
        ],
        [
          '--x',
          'Content-Type: text/plain',
          '',
          'Attached.',
          '--x',
          'Content-Type: application/pdf; name="receipt.pdf"',
          'Content-Disposition: attachment; filename="receipt.pdf"',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from('%PDF-1.4').toString('base64'),
          '--x--',
        ].join('\n'),
      ),
    );
    assert.ok('message' in withFile);
    assert.deepEqual(withFile.message.attachments, [
      { kind: 'file', mimeType: 'application/pdf', filename: 'receipt.pdf' },
    ]);
  });

  it('skips mail with no sender or no content', async () => {
    assert.deepEqual(
      await parse(
        eml(
          [
            ['To', AGENT],
            ['Subject', 'x'],
          ],
          'hi',
        ),
      ),
      { skip: 'no-sender' },
    );
    assert.deepEqual(
      await parse(
        eml(
          [
            ['From', 'a@example.com'],
            ['Subject', 'x'],
          ],
          '   ',
        ),
      ),
      { skip: 'empty', from: 'a@example.com' },
    );
  });
});
