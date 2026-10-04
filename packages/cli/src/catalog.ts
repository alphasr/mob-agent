import { randomBytes } from 'node:crypto';
import type { Channel } from '@textagent/core';
import type { EmailOptions } from '@textagent/email';
import type { IMessageOptions } from '@textagent/imessage';
import type { TelegramOptions } from '@textagent/telegram';
import type { WhatsAppOptions } from '@textagent/whatsapp';

/**
 * The single source of truth for what each channel and template needs: the env vars
 * `create` asks for and writes, the code it generates, and how `doctor` builds the
 * same channel to check it. A test keeps `code` and `env` in sync.
 */

export interface EnvVar {
  name: string;
  /** Question shown by `create`. */
  prompt: string;
  /** Hidden while typing, never printed. */
  secret?: boolean;
  /** Pre-filled when the user skips it. */
  defaultValue?: string;
  /** Generated when empty (verify tokens, shared secrets). */
  generate?: () => string;
  hint?: string;
}

export type ChannelName = 'telegram' | 'whatsapp' | 'email' | 'imessage';
export type TemplateName = 'echo' | 'claude' | 'webhook';

/** Loosely typed module namespace from the project's own node_modules. */
type ChannelModule = Record<string, unknown>;

export interface ChannelSpec {
  name: ChannelName;
  label: string;
  hint: string;
  packageName: string;
  macOnly?: boolean;
  env: EnvVar[];
  /** Factory name and expression used in the generated agent.ts. */
  importName: string;
  code: string;
  /** Build the same channel `code` builds, from the project's installed package. */
  build(mod: ChannelModule, env: Record<string, string | undefined>): Channel;
}

const secretToken = () => randomBytes(24).toString('base64url');

export const CHANNELS: ChannelSpec[] = [
  {
    name: 'telegram',
    label: 'Telegram',
    hint: 'fastest to try: a bot token in 30 seconds',
    packageName: '@textagent/telegram',
    env: [
      {
        name: 'TELEGRAM_BOT_TOKEN',
        prompt: 'Telegram bot token',
        secret: true,
        hint: 'Message @BotFather on Telegram, send /newbot, and paste the token it gives you.',
      },
    ],
    importName: 'telegram',
    code: `telegram({ token: env('TELEGRAM_BOT_TOKEN') })`,
    build: (mod, env) => factory<TelegramOptions>(mod, 'telegram')({ token: env.TELEGRAM_BOT_TOKEN ?? '' }),
  },
  {
    name: 'whatsapp',
    label: 'WhatsApp',
    hint: 'Cloud API; needs a Meta app and a public URL',
    packageName: '@textagent/whatsapp',
    env: [
      {
        name: 'WHATSAPP_ACCESS_TOKEN',
        prompt: 'WhatsApp access token',
        secret: true,
        hint: 'Meta app dashboard → WhatsApp → API Setup.',
      },
      {
        name: 'WHATSAPP_PHONE_NUMBER_ID',
        prompt: 'WhatsApp phone number ID',
        hint: 'Same page; the ID, not the phone number.',
      },
      {
        name: 'WHATSAPP_APP_SECRET',
        prompt: 'Meta app secret',
        secret: true,
        hint: 'App settings → Basic → App secret.',
      },
      {
        name: 'WHATSAPP_VERIFY_TOKEN',
        prompt: 'Webhook verify token',
        generate: secretToken,
        hint: 'Any long random string; you enter the same one in Meta.',
      },
      { name: 'WHATSAPP_PORT', prompt: 'Local webhook port', defaultValue: '3000' },
    ],
    importName: 'whatsapp',
    code: `whatsapp({
      accessToken: env('WHATSAPP_ACCESS_TOKEN'),
      phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
      appSecret: env('WHATSAPP_APP_SECRET'),
      verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
      port: Number(process.env.WHATSAPP_PORT || 3000),
    })`,
    build: (mod, env) =>
      factory<WhatsAppOptions>(
        mod,
        'whatsapp',
      )({
        accessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
        appSecret: env.WHATSAPP_APP_SECRET ?? '',
        verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? '',
      }),
  },
  {
    name: 'email',
    label: 'Email',
    hint: 'any IMAP/SMTP mailbox; Gmail by default',
    packageName: '@textagent/email',
    env: [
      { name: 'EMAIL_ADDRESS', prompt: "The agent's email address" },
      {
        name: 'EMAIL_PASSWORD',
        prompt: 'Email password',
        secret: true,
        hint: 'For Gmail, an app password: Google Account → Security → App passwords.',
      },
      { name: 'EMAIL_IMAP_HOST', prompt: 'IMAP server', defaultValue: 'imap.gmail.com' },
      { name: 'EMAIL_SMTP_HOST', prompt: 'SMTP server', defaultValue: 'smtp.gmail.com' },
    ],
    importName: 'email',
    code: `email({
      address: env('EMAIL_ADDRESS'),
      imap: { host: env('EMAIL_IMAP_HOST'), user: env('EMAIL_ADDRESS'), pass: env('EMAIL_PASSWORD') },
      smtp: { host: env('EMAIL_SMTP_HOST'), user: env('EMAIL_ADDRESS'), pass: env('EMAIL_PASSWORD') },
    })`,
    build: (mod, env) => {
      const auth = { user: env.EMAIL_ADDRESS ?? '', pass: env.EMAIL_PASSWORD ?? '' };
      return factory<EmailOptions>(
        mod,
        'email',
      )({
        address: env.EMAIL_ADDRESS ?? '',
        imap: { host: env.EMAIL_IMAP_HOST ?? '', ...auth },
        smtp: { host: env.EMAIL_SMTP_HOST ?? '', ...auth },
      });
    },
  },
  {
    name: 'imessage',
    label: 'iMessage',
    hint: 'this Mac; needs Full Disk Access',
    packageName: '@textagent/imessage',
    macOnly: true,
    env: [],
    importName: 'imessage',
    code: `imessage()`,
    build: (mod) => factory<IMessageOptions>(mod, 'imessage')({}),
  },
];

export interface TemplateSpec {
  name: TemplateName;
  label: string;
  hint: string;
  env: EnvVar[];
  dependencies: Record<string, string>;
}

export const TEMPLATES: TemplateSpec[] = [
  { name: 'echo', label: 'Echo', hint: 'replies with what you sent; no API key needed', env: [], dependencies: {} },
  {
    name: 'claude',
    label: 'Claude assistant',
    hint: 'answers with Claude; needs an Anthropic API key',
    env: [
      {
        name: 'ANTHROPIC_API_KEY',
        prompt: 'Anthropic API key',
        secret: true,
        hint: 'Create one at platform.claude.com → API keys.',
      },
    ],
    dependencies: { '@anthropic-ai/sdk': '^0.131.0' },
  },
  {
    name: 'webhook',
    label: 'Webhook',
    hint: 'forwards each turn to your own server, in any language',
    env: [
      {
        name: 'WEBHOOK_URL',
        prompt: 'Your server URL that receives turns',
        hint: 'https://, or http://localhost while developing.',
      },
      {
        name: 'WEBHOOK_SECRET',
        prompt: 'Shared signing secret',
        secret: true,
        generate: () => randomBytes(32).toString('base64url'),
        hint: 'Any long random string; you enter the same one in Meta.',
      },
      { name: 'WEBHOOK_PORT', prompt: 'Port for the reply endpoint', defaultValue: '4000' },
    ],
    dependencies: { '@textagent/webhook': '^0.1.0' },
  },
];

/** Who may talk to the agent; required for iMessage, which runs on a personal Apple ID. */
export const ALLOWED_SENDERS: EnvVar = {
  name: 'ALLOWED_SENDERS',
  prompt: 'Who may message the agent? (comma-separated phone numbers, emails or Telegram user IDs; empty = anyone)',
  hint: 'Run the agent once and message it: the log shows each sender ID.',
};

export function channelSpec(name: string): ChannelSpec | undefined {
  return CHANNELS.find((c) => c.name === name);
}

export function templateSpec(name: string): TemplateSpec | undefined {
  return TEMPLATES.find((t) => t.name === name);
}

/** Read a channel factory from an imported module, checking it really is one. */
function factory<Options>(mod: ChannelModule, name: string): (options: Options) => Channel {
  const fn = mod[name];
  if (typeof fn !== 'function') throw new Error(`The installed package does not export ${name}()`);
  return fn as (options: Options) => Channel; // checked to be a function; the package's own types define the signature
}
