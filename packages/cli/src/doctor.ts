import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import type { CheckResult } from '@textagent/core';
import { ALLOWED_SENDERS, DASHBOARD, channelSpec, needsAllowedSenders, templateSpec } from './catalog.ts';
import type { EnvVar } from './catalog.ts';
import { loadProject } from './project.ts';
import type { Project } from './project.ts';

export interface Section {
  title: string;
  results: CheckResult[];
}

/** Run every check and print a report. Resolves to true when everything passed. Only reads; never sends. */
export async function doctor(dir: string, write: (line: string) => void = console.log): Promise<boolean> {
  const sections = await runChecks(dir);
  for (const section of sections) {
    write(styleText('bold', section.title));
    for (const r of section.results) {
      const mark = r.ok ? styleText('green', '✔') : styleText('red', '✖');
      write(`  ${mark} ${r.name}${r.detail ? styleText('dim', ` · ${r.detail}`) : ''}`);
      if (!r.ok && r.fix) write(`      ${styleText('yellow', '→')} ${r.fix}`);
    }
  }
  const failed = sections.flatMap((s) => s.results).filter((r) => !r.ok).length;
  write(failed ? styleText('red', `\n${failed} problem(s) found.`) : styleText('green', '\nAll checks passed.'));
  return failed === 0;
}

export async function runChecks(dir: string): Promise<Section[]> {
  const major = Number(process.versions.node.split('.')[0]);
  const sections: Section[] = [
    {
      title: 'Environment',
      results: [
        major >= 24
          ? { name: 'Node.js', ok: true, detail: process.versions.node }
          : { name: 'Node.js', ok: false, detail: process.versions.node, fix: 'Install Node.js 24 or newer.' },
      ],
    },
  ];

  let project: Project;
  try {
    project = await loadProject(dir);
  } catch (error) {
    sections[0]!.results.push({ name: 'textagent project', ok: false, detail: (error as Error).message });
    return sections;
  }

  if (needsAllowedSenders(project) && !project.env[ALLOWED_SENDERS.name]) {
    sections[0]!.results.push({
      name: ALLOWED_SENDERS.name,
      ok: false,
      detail: project.channels.includes('imessage')
        ? 'empty, so anyone texting your Apple ID would get answers'
        : 'empty; the assistant keeps personal notes, so it refuses to start without it',
      fix: 'List the numbers or emails the agent may answer in .env.',
    });
  }

  for (const name of project.channels) {
    const spec = channelSpec(name)!;
    const results = missingEnv(project, spec.env);
    if (results.length === 0) results.push(...(await channelChecks(project, name)));
    sections.push({ title: spec.label, results });
  }

  const template = templateSpec(project.template)!;
  const templateResults = missingEnv(project, template.env);
  // Offline checks first; the API key check makes a request and only runs when the rest is in order.
  if (templateResults.length === 0 && project.template === 'support') templateResults.push(operatorCheck(project));
  if (templateResults.length === 0 && project.template === 'booking') templateResults.push(await bookingCheck(project));
  if (templateResults.length === 0 && project.template === 'assistant')
    templateResults.push(await timezoneCheck(project));
  const usesClaude = templateSpec(project.template)!.files?.includes('claude.ts');
  if (templateResults.every((r) => r.ok) && usesClaude) templateResults.push(await claudeCheck(project));
  if (templateResults.length === 0 && project.template === 'webhook') templateResults.push(webhookCheck(project));
  if (template.env.length) sections.push({ title: `${template.label} template`, results: templateResults });

  if (project.dashboard) {
    const results = missingEnv(project, DASHBOARD.env);
    if (results.length === 0) results.push(await dashboardCheck(project));
    sections.push({ title: 'Dashboard', results });
  }

  return sections;
}

/** Settings with a default (ports) are optional; the generated code falls back to the default. */
function missingEnv(project: Project, vars: EnvVar[]): CheckResult[] {
  return vars
    .filter((v) => v.defaultValue === undefined && !project.env[v.name])
    .map((v) => ({ name: v.name, ok: false, detail: 'not set', fix: `Add ${v.name}=... to .env` }));
}

async function channelChecks(project: Project, name: string): Promise<CheckResult[]> {
  const spec = channelSpec(name)!;
  try {
    const channel = spec.build(await importFromProject(project.dir, spec.packageName), project.env);
    return channel.check ? await channel.check() : [{ name: spec.label, ok: true, detail: 'no checks available' }];
  } catch (error) {
    return [
      { name: spec.packageName, ok: false, detail: (error as Error).message, fix: 'Run `npm install` in the project.' },
    ];
  }
}

/** Read-only and free: looking up the model proves the key works. */
async function claudeCheck(project: Project): Promise<CheckResult> {
  try {
    const sdk = await importFromProject(project.dir, '@anthropic-ai/sdk');
    const Anthropic = sdk.default as new (options: { apiKey?: string }) => {
      models: { retrieve(id: string): Promise<{ display_name?: string }> };
    }; // the SDK's default export is the client class
    const model = await new Anthropic({ apiKey: project.env.ANTHROPIC_API_KEY }).models.retrieve('claude-opus-5-5');
    return { name: 'Anthropic API key', ok: true, detail: model.display_name ?? 'claude-opus-5-5' };
  } catch (error) {
    return {
      name: 'Anthropic API key',
      ok: false,
      detail: (error as Error).message,
      fix: 'Create a key at platform.claude.com and set ANTHROPIC_API_KEY in .env.',
    };
  }
}

/** Handoffs go out on one of the project's own channels; anything else fails when the first handoff happens. */
function operatorCheck(project: Project): CheckResult {
  const channel = project.env.OPERATOR_CHANNEL ?? '';
  if (!(project.channels as string[]).includes(channel)) {
    return {
      name: 'OPERATOR_CHANNEL',
      ok: false,
      detail: `"${channel}" is not one of this agent's channels`,
      fix: `Use one of: ${project.channels.join(', ')}`,
    };
  }
  return { name: 'Handoffs', ok: true, detail: `to ${project.env.OPERATOR_TO} on ${channel}` };
}

/** Validates booking.config.json with the project's own booking.ts, as the agent does at startup. */
async function bookingCheck(project: Project): Promise<CheckResult> {
  try {
    const mod = await import(pathToFileURL(join(project.dir, 'booking.ts')).href);
    const load = mod.loadBookingConfig as (json: string) => { timezone: string; slotMinutes: number }; // booking.ts
    const config = load(await readFile(join(project.dir, 'booking.config.json'), 'utf8'));
    return { name: 'booking.config.json', ok: true, detail: `${config.slotMinutes}-minute slots, ${config.timezone}` };
  } catch (error) {
    return {
      name: 'booking.config.json',
      ok: false,
      detail: (error as Error).message,
      fix: 'Fix booking.config.json (see the README).',
    };
  }
}

/** Checks TIMEZONE with the project's own time.ts, as the agent does at startup. */
async function timezoneCheck(project: Project): Promise<CheckResult> {
  const timezone = project.env.TIMEZONE ?? '';
  const mod = await import(pathToFileURL(join(project.dir, 'time.ts')).href);
  const isTimezone = mod.isTimezone as (name: string) => boolean; // time.ts
  return isTimezone(timezone)
    ? { name: 'TIMEZONE', ok: true, detail: timezone }
    : {
        name: 'TIMEZONE',
        ok: false,
        detail: `"${timezone}" is not a timezone`,
        fix: 'Use an IANA name like Europe/London.',
      };
}

function webhookCheck(project: Project): CheckResult {
  const url = project.env.WEBHOOK_URL ?? '';
  const secret = project.env.WEBHOOK_SECRET ?? '';
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // reported below
  }
  const local = parsed && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!parsed || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))) {
    return { name: 'WEBHOOK_URL', ok: false, detail: url, fix: 'Use an https:// URL (http:// only for localhost).' };
  }
  if (secret.length < 32) {
    return { name: 'WEBHOOK_SECRET', ok: false, detail: 'shorter than 32 characters', fix: 'Use a long random value.' };
  }
  return { name: 'Webhook settings', ok: true, detail: parsed.origin };
}

/**
 * Builds the exporter the agent would build, which validates the URL and hash secret without
 * sending anything (nothing is buffered yet, so `close()` has nothing to flush).
 */
async function dashboardCheck(project: Project): Promise<CheckResult> {
  let exporter: (options: Record<string, unknown>) => { close(): Promise<void> };
  try {
    const mod = await importFromProject(project.dir, DASHBOARD.packageName);
    exporter = mod.exporter as typeof exporter; // @textagent/cloud's exporter(); its own types define the options
  } catch (error) {
    const detail = (error as Error).message;
    return { name: DASHBOARD.packageName, ok: false, detail, fix: 'Run `npm install` in the project.' };
  }
  try {
    await exporter({
      url: project.env.TEXTAGENT_INGEST_URL,
      key: project.env.TEXTAGENT_KEY,
      hashSecret: project.env.TEXTAGENT_HASH_SECRET,
    }).close();
  } catch (error) {
    return {
      name: 'Dashboard settings',
      ok: false,
      detail: (error as Error).message.replace(/^exporter\(\): /, ''),
      fix: 'Fix TEXTAGENT_INGEST_URL / TEXTAGENT_HASH_SECRET in .env.',
    };
  }
  // missingEnv ruled out an empty URL, and exporter() just parsed it.
  return { name: 'Dashboard settings', ok: true, detail: new URL(project.env.TEXTAGENT_INGEST_URL!).origin };
}

/** Import a package as installed in the project, so checks use the project's own versions. */
async function importFromProject(dir: string, specifier: string): Promise<Record<string, unknown>> {
  const resolved = createRequire(join(dir, 'package.json')).resolve(specifier);
  return import(pathToFileURL(resolved).href) as Promise<Record<string, unknown>>;
}
