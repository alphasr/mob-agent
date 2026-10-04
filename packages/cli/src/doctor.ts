import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import type { CheckResult } from '@textagent/core';
import { ALLOWED_SENDERS, channelSpec, templateSpec } from './catalog.ts';
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

  if (project.channels.includes('imessage') && !project.env[ALLOWED_SENDERS.name]) {
    sections[0]!.results.push({
      name: ALLOWED_SENDERS.name,
      ok: false,
      detail: 'empty, so anyone texting your Apple ID would get answers',
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
  if (templateResults.length === 0 && project.template === 'claude') templateResults.push(await claudeCheck(project));
  if (templateResults.length === 0 && project.template === 'webhook') templateResults.push(webhookCheck(project));
  if (template.env.length) sections.push({ title: `${template.label} template`, results: templateResults });

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

/** Import a package as installed in the project, so checks use the project's own versions. */
async function importFromProject(dir: string, specifier: string): Promise<Record<string, unknown>> {
  const resolved = createRequire(join(dir, 'package.json')).resolve(specifier);
  return import(pathToFileURL(resolved).href) as Promise<Record<string, unknown>>;
}
