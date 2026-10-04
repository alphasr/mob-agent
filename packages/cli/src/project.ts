import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { channelSpec, templateSpec } from './catalog.ts';
import type { ChannelName, TemplateName } from './catalog.ts';

export interface Project {
  dir: string;
  channels: ChannelName[];
  template: TemplateName;
  entry: string;
  /** .env merged under the real environment (real env wins, as with `node --env-file`). */
  env: Record<string, string | undefined>;
}

/** Load the textagent project in `dir`, or explain why it isn't one. */
export async function loadProject(dir: string): Promise<Project> {
  let pkg: { textagent?: { channels?: unknown; template?: unknown; entry?: unknown } };
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`No package.json in ${dir}. Run this inside a project made with \`npm create textagent\`.`);
  }
  const config = pkg.textagent;
  if (!config)
    throw new Error('This package.json has no "textagent" section. Was it made with `npm create textagent`?');

  const channels = Array.isArray(config.channels)
    ? config.channels.filter((c): c is ChannelName => typeof c === 'string' && !!channelSpec(c))
    : [];
  const template =
    typeof config.template === 'string' && templateSpec(config.template) ? (config.template as TemplateName) : 'echo';
  const entry = typeof config.entry === 'string' ? config.entry : 'agent.ts';

  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(await readFile(join(dir, '.env'), 'utf8')) as Record<string, string>;
  } catch {
    // No .env: doctor reports each missing variable.
  }
  return { dir, channels, template, entry, env: { ...fileEnv, ...process.env } };
}
