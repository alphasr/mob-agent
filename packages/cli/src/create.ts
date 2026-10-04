import { spawn } from 'node:child_process';
import { relative } from 'node:path';
import * as p from '@clack/prompts';
import { ALLOWED_SENDERS, CHANNELS, TEMPLATES, channelSpec, templateSpec } from './catalog.ts';
import type { ChannelName, EnvVar, TemplateName } from './catalog.ts';
import { envVarsFor, writeProject } from './scaffold.ts';
import type { ProjectPlan } from './scaffold.ts';

export interface CreateOptions {
  dir?: string;
  channels?: string;
  template?: string;
  /** Accept defaults; never prompt. Implied when stdin isn't a terminal. */
  yes?: boolean;
  force?: boolean;
  install?: boolean;
  link?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
}

export async function create(options: CreateOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const interactive = !options.yes && process.stdin.isTTY === true;
  if (interactive) p.intro('Create an agent people can text');

  const dir =
    options.dir ??
    (interactive
      ? await ask(p.text({ message: 'Project folder', placeholder: 'my-agent', defaultValue: 'my-agent' }))
      : 'my-agent');
  const channels = await pickChannels(options.channels, interactive, platform);
  const template = await pickTemplate(options.template, interactive);

  const plan: ProjectPlan = { dir, channels, template, env: {}, ...(options.link && { link: options.link }) };
  for (const v of envVarsFor(plan)) {
    const required = v === ALLOWED_SENDERS && channels.includes('imessage');
    plan.env[v.name] = interactive ? await askEnv(v, required) : (v.generate?.() ?? v.defaultValue ?? '');
  }

  const path = await writeProject(plan, { force: options.force ?? false });
  const shown = relative(options.cwd ?? process.cwd(), path) || '.';

  if (options.install !== false) {
    const pm = packageManager();
    const spinner = interactive ? p.spinner() : undefined;
    spinner?.start(`Installing with ${pm}`);
    try {
      await run(pm, ['install'], path);
      spinner?.stop('Installed');
    } catch (error) {
      spinner?.error('Install failed');
      throw new Error(`Created ${shown}, but \`${pm} install\` failed: ${(error as Error).message}`);
    }
  }

  const missing = envVarsFor(plan).filter((v) => !plan.env[v.name] && v !== ALLOWED_SENDERS);
  const next = [
    `cd ${shown}`,
    ...(missing.length ? [`fill in ${missing.map((v) => v.name).join(', ')} in .env`] : []),
    'npm run dev',
  ];
  if (interactive) {
    p.note(next.join('\n'), 'Next');
    p.outro('Then message your agent. `npm run doctor` checks the setup if anything is off.');
  } else {
    console.log(`Created ${shown}. Next:\n  ${next.join('\n  ')}`);
  }
}

async function pickChannels(
  flag: string | undefined,
  interactive: boolean,
  platform: NodeJS.Platform,
): Promise<ChannelName[]> {
  const available = CHANNELS.filter((c) => !c.macOnly || platform === 'darwin');
  if (flag !== undefined) {
    const names = flag
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = names.filter((n) => !channelSpec(n));
    if (unknown.length)
      throw new Error(
        `Unknown channel(s): ${unknown.join(', ')}. Choose from: ${CHANNELS.map((c) => c.name).join(', ')}`,
      );
    const skipped = names.filter((n) => channelSpec(n)!.macOnly && platform !== 'darwin');
    if (skipped.length) console.warn(`Skipping ${skipped.join(', ')}: only works on macOS.`);
    const chosen = names.filter((n) => !skipped.includes(n)) as ChannelName[];
    if (chosen.length === 0) throw new Error('No usable channels left. Pick at least one channel.');
    return chosen;
  }
  if (!interactive) return ['telegram'];
  return ask(
    p.multiselect<ChannelName>({
      message: 'Where should people reach your agent?',
      options: available.map((c) => ({ value: c.name, label: c.label, hint: c.hint })),
      initialValues: ['telegram'],
      required: true,
    }),
  );
}

async function pickTemplate(flag: string | undefined, interactive: boolean): Promise<TemplateName> {
  if (flag !== undefined) {
    if (!templateSpec(flag))
      throw new Error(`Unknown template "${flag}". Choose from: ${TEMPLATES.map((t) => t.name).join(', ')}`);
    return flag as TemplateName; // validated against the catalog above
  }
  if (!interactive) return 'echo';
  return ask(
    p.select<TemplateName>({
      message: 'What should it do?',
      options: TEMPLATES.map((t) => ({ value: t.name, label: t.label, hint: t.hint })),
      initialValue: 'echo',
    }),
  );
}

async function askEnv(v: EnvVar, required: boolean): Promise<string> {
  if (v.hint) p.log.info(v.hint);
  const message = required
    ? `${v.prompt} (required for iMessage)`
    : `${v.prompt}${v.generate ? ' (Enter to generate one)' : v.defaultValue ? '' : ' (Enter to fill in later)'}`;
  const validate = (value: string | undefined) =>
    required && !value?.trim() ? 'iMessage runs on your own Apple ID, so list who it may answer.' : undefined;
  const value = v.secret
    ? await ask(p.password({ message, validate }))
    : await ask(
        p.text({
          message,
          ...(v.defaultValue && { placeholder: v.defaultValue, defaultValue: v.defaultValue }),
          validate,
        }),
      );
  return value?.trim() || v.generate?.() || v.defaultValue || '';
}

/** Unwrap a prompt result, exiting cleanly on Ctrl+C. */
async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (p.isCancel(value)) {
    p.cancel('Cancelled. Nothing was written.');
    process.exit(0);
  }
  return value as Exclude<T, symbol>; // isCancel ruled out the cancel symbol
}

/** The package manager that launched us (`npm create`, `pnpm create`, ...), else npm. */
function packageManager(): string {
  const agent = process.env.npm_config_user_agent ?? '';
  for (const pm of ['pnpm', 'yarn', 'bun']) if (agent.startsWith(pm)) return pm;
  return 'npm';
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exited with code ${code}`))));
  });
}
