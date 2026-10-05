import { readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ALLOWED_SENDERS, DASHBOARD, channelSpec, templateSpec } from './catalog.ts';
import type { ChannelName, EnvVar, TemplateName } from './catalog.ts';

export interface ProjectPlan {
  dir: string;
  channels: ChannelName[];
  template: TemplateName;
  /** Send turn traces to a dashboard with `@textagent/cloud`. */
  dashboard?: boolean;
  /** Values for every env var the plan needs; empty strings are written as blanks for `doctor` to flag. */
  env: Record<string, string>;
  /** Monorepo root: depend on local packages via file: links instead of npm (for contributors). */
  link?: string;
}

const TEXTAGENT_VERSION = '^0.1.0';

/** Every env var the plan needs, in the order they appear in .env. */
export function envVarsFor(plan: Pick<ProjectPlan, 'channels' | 'template' | 'dashboard'>): EnvVar[] {
  return [
    ...plan.channels.flatMap((c) => channelSpec(c)!.env),
    ...templateSpec(plan.template)!.env,
    ...(plan.dashboard ? DASHBOARD.env : []),
    ALLOWED_SENDERS,
  ];
}

export function renderFiles(plan: ProjectPlan): Record<string, string> {
  const name = packageName(plan.dir);
  const dep = (pkg: string) =>
    plan.link ? `file:${join(plan.link, 'packages', pkg.replace('@textagent/', ''))}` : TEXTAGENT_VERSION;
  const dependencies: Record<string, string> = { '@textagent/core': dep('@textagent/core') };
  for (const c of plan.channels) dependencies[channelSpec(c)!.packageName] = dep(channelSpec(c)!.packageName);
  for (const [pkg, version] of Object.entries(templateSpec(plan.template)!.dependencies)) {
    dependencies[pkg] = pkg.startsWith('@textagent/') ? dep(pkg) : version;
  }
  if (plan.dashboard) dependencies[DASHBOARD.packageName] = dep(DASHBOARD.packageName);

  const pkg = {
    name,
    private: true,
    type: 'module',
    scripts: {
      dev: 'textagent dev',
      start: 'node --env-file-if-exists=.env agent.ts',
      doctor: 'textagent doctor',
    },
    dependencies: sortKeys(dependencies),
    devDependencies: {
      '@types/node': '^24.0.0',
      textagent: plan.link ? `file:${join(plan.link, 'packages', 'cli')}` : TEXTAGENT_VERSION,
    },
    engines: { node: '>=24' },
    textagent: {
      channels: plan.channels,
      template: plan.template,
      ...(plan.dashboard && { dashboard: true }),
      entry: 'agent.ts',
    },
  };

  const vars = envVarsFor(plan);
  return {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'agent.ts': renderAgent(plan),
    '.env': renderEnv(vars, plan.env),
    '.env.example': renderEnv(vars, {}),
    '.gitignore': ['node_modules/', '.env', '*.sqlite', '*.sqlite-*', ''].join('\n'),
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          erasableSyntaxOnly: true,
          skipLibCheck: true,
        },
      },
      null,
      2,
    )}\n`,
    'README.md': renderReadme(name, plan),
    ...templateFiles(plan.template),
  };
}

export function renderAgent(plan: Pick<ProjectPlan, 'channels' | 'template' | 'dashboard'>): string {
  const channels = plan.channels.map((c) => channelSpec(c)!);
  const extra = TEMPLATE_IMPORTS[plan.template];
  const isLocal = (line: string) => /from '(\.\/|@textagent\/)/.test(line);
  const imports = [
    ...extra.filter((line) => !isLocal(line)),
    `import { Agent, SqliteStore, logEvents } from '@textagent/core';`,
    ...channels.map((c) => `import { ${c.importName} } from '${c.packageName}';`),
    ...extra.filter(isLocal),
  ];
  if (plan.dashboard) imports.push(`import { exporter } from '${DASHBOARD.packageName}';`);
  const shutdownSteps = [
    ...(plan.template === 'webhook' ? ['await hook.close();'] : []),
    'await agent.stop();',
    ...(plan.dashboard ? ['await traces.close(); // sends the last buffered traces'] : []),
    'process.exit(0);',
  ];

  return `${imports.join('\n')}

/** Read a required setting from .env, with a hint instead of a crash deep inside a channel. */
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing \${name} in .env. Run \\\`npm run doctor\\\` to check your setup.\`);
  return value;
}

const allowed = (process.env.ALLOWED_SENDERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const agent = new Agent({
  channels: [
    ${channels.map((c) => c.code).join(',\n    ')},
  ],
  store: new SqliteStore('agent.sqlite'),
  ...(allowed.length > 0 && { allow: (message) => allowed.includes(message.sender.id) }),
});

agent.on('event', logEvents());
${plan.dashboard ? DASHBOARD_WIRING : ''}${HANDLERS[plan.template]}
await agent.start();
console.log('Agent running. Message it, or press Ctrl+C to stop.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown());
}
async function shutdown() {
  ${shutdownSteps.join('\n  ')}
}
`;
}

const READ_FILE = `import { readFileSync } from 'node:fs';`;
const ANTHROPIC = [`import Anthropic from '@anthropic-ai/sdk';`, `import { reply } from './claude.ts';`];

/** What each template's handler imports besides core and the channels; packages first, then local files. */
const TEMPLATE_IMPORTS: Record<TemplateName, string[]> = {
  echo: [],
  claude: ANTHROPIC,
  support: [READ_FILE, ...ANTHROPIC, `import { Handoffs, conversationOf, handoffTool } from './support.ts';`],
  booking: [
    READ_FILE,
    ...ANTHROPIC,
    `import { Bookings, bookingTools, loadBookingConfig } from './booking.ts';`,
    `import { describeNow } from './time.ts';`,
  ],
  assistant: [
    ...ANTHROPIC,
    `import { Notes, assistantTools } from './assistant.ts';`,
    `import { describeNow, isTimezone } from './time.ts';`,
  ],
  webhook: [`import { webhook } from '@textagent/webhook';`],
};

const DASHBOARD_WIRING = `
// Turn timings, token usage and cost go to the dashboard. Phone numbers and emails are hashed
// first, and message text stays here unless you add \`includeText: true\`.
const traces = ${DASHBOARD.code};
agent.on('event', traces);
`;

const HANDLERS: Record<TemplateName, string> = {
  echo: `
agent.on('message', async (ctx) => {
  await ctx.typing();
  await ctx.reply(\`You said: \${ctx.text}\`);
});
`,

  claude: `
const claude = new Anthropic(); // reads ANTHROPIC_API_KEY

// Fixed instructions only. Message text and sender names come from users, so they
// only ever go in \`messages\`, never in here.
const SYSTEM = [
  'You are a helpful assistant that people reach by text message.',
  'Reply in plain text without Markdown, briefly, the way a person texts.',
].join(' ');

agent.on('message', async (ctx) => {
  await ctx.typing();
  const text = await reply(claude, ctx, { system: SYSTEM });
  if (text) await ctx.reply(text);
});
`,

  support: `
const claude = new Anthropic(); // reads ANTHROPIC_API_KEY
const handoffs = new Handoffs('support.sqlite');
// Who receives handoffs is fixed here: nothing a customer writes can redirect them.
const operator = { channel: env('OPERATOR_CHANNEL'), to: env('OPERATOR_TO') };

// Fixed instructions plus your knowledge base (edit knowledge.md, then restart). Customers' messages are
// user input: they only ever go in \`messages\`, never in here.
const SYSTEM = [
  'You are the support assistant for this business, reached by text message.',
  'Answer only from the knowledge base below. If it does not cover the question, if the person asks for a human,',
  'or if something needs a person to act, use handoff_to_human instead of guessing.',
  'Reply in plain text without Markdown, briefly, the way a person texts.',
  '',
  '<knowledge_base>',
  readFileSync('knowledge.md', 'utf8'),
  '</knowledge_base>',
].join('\\n');

agent.on('message', async (ctx) => {
  // A person from your team has this conversation; stay quiet until the pause ends.
  if (handoffs.isPaused(conversationOf(ctx))) return;
  await ctx.typing();
  const text = await reply(claude, ctx, { system: SYSTEM, tools: [handoffTool(agent, ctx, operator, handoffs)] });
  if (text) await ctx.reply(text);
});
`,

  booking: `
const claude = new Anthropic(); // reads ANTHROPIC_API_KEY
// Opening hours, slot length and limits: edit booking.config.json, then restart.
const bookings = new Bookings(loadBookingConfig(readFileSync('booking.config.json', 'utf8')), 'booking.sqlite');

// Fixed instructions only. Customers' messages are user input: they only ever go in \`messages\`, never in here.
const INSTRUCTIONS = [
  'You book appointments for this business by text message, using the booking tools.',
  'Only offer times that list_open_slots returns, and book only a time the person has clearly chosen.',
  'People can see and cancel only their own bookings. To move a booking, book the new time, then cancel the old one.',
  'Reply in plain text without Markdown, briefly, the way a person texts.',
].join(' ');

agent.on('message', async (ctx) => {
  await ctx.typing();
  const text = await reply(claude, ctx, {
    system: \`\${INSTRUCTIONS}\\n\${describeNow(bookings.config.timezone)}\`,
    tools: bookingTools(agent, ctx, bookings),
  });
  if (text) await ctx.reply(text);
});
`,

  assistant: `
const claude = new Anthropic(); // reads ANTHROPIC_API_KEY
const TIMEZONE = env('TIMEZONE');
if (!isTimezone(TIMEZONE)) throw new Error(\`TIMEZONE=\${TIMEZONE} in .env is not a timezone like Europe/London.\`);
// Notes and reminders are personal: this agent only runs for the senders you list.
if (allowed.length === 0) throw new Error('Set ALLOWED_SENDERS in .env to your own sender ID first.');
const notes = new Notes('assistant.sqlite');

// Fixed instructions only. Messages are user input: they only ever go in \`messages\`, never in here.
const INSTRUCTIONS = [
  'You are a personal assistant that your owner reaches by text message.',
  'Save notes when they ask you to remember something, and search them before saying you do not know.',
  'Set reminders for the times they give; if a time is unclear, ask instead of guessing.',
  'Reply in plain text without Markdown, briefly, the way a person texts.',
].join(' ');

agent.on('message', async (ctx) => {
  await ctx.typing();
  const text = await reply(claude, ctx, {
    system: \`\${INSTRUCTIONS}\\n\${describeNow(TIMEZONE)}\`,
    tools: assistantTools(agent, ctx, notes, TIMEZONE),
  });
  if (text) await ctx.reply(text);
});
`,

  webhook: `
// Each turn is POSTed to your server, which answers 2xx and replies later via the signed API.
const hook = webhook({
  url: env('WEBHOOK_URL'),
  secret: env('WEBHOOK_SECRET'),
  port: Number(process.env.WEBHOOK_PORT || 4000),
});
agent.on('message', hook.handler);
console.log(\`Reply endpoint: \${await hook.listen()}\`);
`,
};

function renderEnv(vars: EnvVar[], values: Record<string, string>): string {
  const lines = ['# Secrets for this agent. Never commit this file.', ''];
  for (const v of vars) {
    lines.push(`# ${v.prompt}${v.hint ? `. ${v.hint}` : ''}`);
    lines.push(`${v.name}=${quoteEnv(v.name, values[v.name] ?? '')}`, '');
  }
  return lines.join('\n');
}

/**
 * Node's .env parser has no escape sequences: quotes are literal delimiters and an
 * unquoted # starts a comment. So wrap each value in a quote character it doesn't contain.
 */
function quoteEnv(name: string, value: string): string {
  if (/^[\w@.:/+=,-]*$/.test(value)) return value;
  const quote = [`'`, '"', '`'].find((q) => !value.includes(q));
  if (!quote || /[\r\n]/.test(value)) {
    throw new Error(`${name} can't be stored in .env: it contains line breaks or all three quote characters.`);
  }
  return `${quote}${value}${quote}`;
}

function renderReadme(name: string, plan: ProjectPlan): string {
  const steps = plan.channels.map((c) => {
    switch (c) {
      case 'telegram':
        return '- **Telegram**: open your bot in Telegram and send it a message.';
      case 'whatsapp':
        return '- **WhatsApp**: `npm run dev` prints a public URL; set it as the webhook in the Meta app dashboard, with the verify token from `.env`.';
      case 'email':
        return "- **Email**: send an email to the agent's address.";
      case 'imessage':
        return '- **iMessage**: give your terminal Full Disk Access, then text this Mac from a number in `ALLOWED_SENDERS`.';
    }
  });
  return `# ${name}

An agent people can text, built with [textagent](https://github.com/alphasr/textagent).

\`\`\`sh
npm run dev      # run with live reload and a readable event log
npm run doctor   # check credentials and permissions
\`\`\`

Then message it:

${steps.join('\n')}

The agent's logic is in \`agent.ts\`. Settings and secrets are in \`.env\`.${
    plan.template === 'support'
      ? `

The agent answers from \`knowledge.md\`: replace the examples with your own facts and restart. When it can't help,
it sends a summary to \`OPERATOR_TO\` on \`OPERATOR_CHANNEL\` and stays quiet in that conversation for 24 hours
while a person replies.`
      : ''
  }${
    plan.template === 'booking'
      ? `

Opening hours, slot length, timezone and limits are in \`booking.config.json\`; bookings are kept in
\`booking.sqlite\`. Each person can see and cancel only their own bookings, and gets a reminder 24 hours before.`
      : ''
  }${
    plan.template === 'assistant'
      ? `

Text it things to remember ("note: the wifi password is …") and reminders ("remind me Friday at 9 to call
the bank"). Notes are in \`assistant.sqlite\`, one notebook per sender ID; reminders use \`TIMEZONE\`. It only
answers the senders in \`ALLOWED_SENDERS\`, and won't start without them.`
      : ''
  }
`;
}

/** Write the project. Refuses a non-empty directory unless `force`. Returns the absolute path. */
export async function writeProject(plan: ProjectPlan, options: { force?: boolean } = {}): Promise<string> {
  const dir = resolve(plan.dir);
  await mkdir(dir, { recursive: true });
  const existing = (await readdir(dir)).filter((f) => f !== '.DS_Store' && f !== '.git');
  if (existing.length > 0 && !options.force) {
    throw new Error(`${dir} is not empty. Choose another directory, or pass --force to write into it anyway.`);
  }
  for (const [file, content] of Object.entries(renderFiles(plan))) {
    // .env holds secrets: owner read/write only, set at creation so it's never briefly world-readable.
    await writeFile(join(dir, file), content, file === '.env' ? { mode: 0o600 } : {});
  }
  await chmod(join(dir, '.env'), 0o600); // writeFile's mode doesn't apply when overwriting with --force
  return dir;
}

/** Files the template ships as they are (e.g. claude.ts), from the package's templates/ folder. */
function templateFiles(template: TemplateName): Record<string, string> {
  const files = templateSpec(template)!.files ?? [];
  return Object.fromEntries(files.map((f) => [f, readFileSync(new URL(`../templates/${f}`, import.meta.url), 'utf8')]));
}

/** npm package names: lowercase, no spaces; derived from the directory name. */
export function packageName(dir: string): string {
  const base = resolve(dir).split(/[\\/]/).pop() ?? 'my-agent';
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+|[-]+$/g, '') || 'my-agent'
  );
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
