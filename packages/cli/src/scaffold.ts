import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ALLOWED_SENDERS, channelSpec, templateSpec } from './catalog.ts';
import type { ChannelName, EnvVar, TemplateName } from './catalog.ts';

export interface ProjectPlan {
  dir: string;
  channels: ChannelName[];
  template: TemplateName;
  /** Values for every env var the plan needs; empty strings are written as blanks for `doctor` to flag. */
  env: Record<string, string>;
  /** Monorepo root: depend on local packages via file: links instead of npm (for contributors). */
  link?: string;
}

const TEXTAGENT_VERSION = '^0.1.0';

/** Every env var the plan needs, in the order they appear in .env. */
export function envVarsFor(plan: Pick<ProjectPlan, 'channels' | 'template'>): EnvVar[] {
  return [...plan.channels.flatMap((c) => channelSpec(c)!.env), ...templateSpec(plan.template)!.env, ALLOWED_SENDERS];
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
    textagent: { channels: plan.channels, template: plan.template, entry: 'agent.ts' },
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
  };
}

export function renderAgent(plan: Pick<ProjectPlan, 'channels' | 'template'>): string {
  const channels = plan.channels.map((c) => channelSpec(c)!);
  const imports = [
    `import { Agent, SqliteStore, logEvents } from '@textagent/core';`,
    ...channels.map((c) => `import { ${c.importName} } from '${c.packageName}';`),
  ];
  if (plan.template === 'claude') imports.unshift(`import Anthropic from '@anthropic-ai/sdk';`);
  if (plan.template === 'webhook') imports.push(`import { webhook } from '@textagent/webhook';`);

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
${HANDLERS[plan.template]}
await agent.start();
console.log('Agent running. Message it, or press Ctrl+C to stop.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown());
}
async function shutdown() {
  ${plan.template === 'webhook' ? 'await hook.close();\n  ' : ''}await agent.stop();
  process.exit(0);
}
`;
}

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
  const messages: Anthropic.Beta.BetaMessageParam[] = (await ctx.history(20)).map((entry) => ({
    role: entry.role === 'agent' ? 'assistant' : 'user',
    content: entry.text || '(sent an attachment)',
  }));
  while (messages[0]?.role === 'assistant') messages.shift(); // a conversation must start with the user

  const response = await claude.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    system: SYSTEM,
    // Texting wants quick replies; raise to 'medium' or 'high' for harder questions.
    output_config: { effort: 'low' },
    // If a request is declined, the API retries it on a fallback model within the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages,
  });

  if (response.stop_reason === 'refusal') {
    await ctx.reply("Sorry, I can't help with that.");
    return;
  }
  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\\n')
    .trim();
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

The agent's logic is in \`agent.ts\`. Settings and secrets are in \`.env\`.
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
