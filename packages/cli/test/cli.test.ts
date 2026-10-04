import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import { CHANNELS, TEMPLATES } from '../src/catalog.ts';
import { create } from '../src/create.ts';
import { tunnelUrl } from '../src/dev.ts';
import { runChecks } from '../src/doctor.ts';
import { packageName, renderFiles, writeProject } from '../src/scaffold.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('catalog', () => {
  it('generated code reads exactly the env vars each channel declares', () => {
    for (const channel of CHANNELS) {
      const used = new Set([...channel.code.matchAll(/env\('(\w+)'\)|process\.env\.(\w+)/g)].map((m) => m[1] ?? m[2]));
      assert.deepEqual([...used].sort(), channel.env.map((v) => v.name).sort(), channel.name);
    }
  });
});

describe('scaffold', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'textagent-cli-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes a project with a private .env and secrets kept out of git', async () => {
    const dir = await writeProject({
      dir: join(tmp, 'My Agent!'),
      channels: ['telegram', 'whatsapp'],
      template: 'claude',
      env: { TELEGRAM_BOT_TOKEN: '123:abc', WHATSAPP_VERIFY_TOKEN: 'v "quoted" #hash' },
    });
    assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.env$/m);

    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    assert.equal(env.TELEGRAM_BOT_TOKEN, '123:abc');
    assert.equal(env.WHATSAPP_VERIFY_TOKEN, 'v "quoted" #hash', 'values with quotes and # survive');
    const example = parseEnv(readFileSync(join(dir, '.env.example'), 'utf8'));
    assert.equal(example.TELEGRAM_BOT_TOKEN, '', '.env.example never carries secrets');

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-agent');
    assert.deepEqual(Object.keys(pkg.dependencies), [
      '@anthropic-ai/sdk',
      '@textagent/core',
      '@textagent/telegram',
      '@textagent/whatsapp',
    ]);
    assert.deepEqual(pkg.textagent, { channels: ['telegram', 'whatsapp'], template: 'claude', entry: 'agent.ts' });
  });

  it('refuses a non-empty directory unless forced, and keeps .env private when overwriting', async () => {
    const dir = join(tmp, 'busy');
    await mkdir(dir);
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeFileSync(join(dir, '.env'), 'OLD=1', { mode: 0o644 });
    const plan = { dir, channels: ['telegram' as const], template: 'echo' as const, env: {} };
    await assert.rejects(writeProject(plan), /not empty.*--force/);
    await writeProject(plan, { force: true });
    assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine', 'unrelated files untouched');
  });

  it('derives valid npm package names', () => {
    assert.equal(packageName('/x/Weekend Bot'), 'weekend-bot');
    assert.equal(packageName('/x/__'), 'my-agent');
  });
});

describe('create (non-interactive)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'textagent-create-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const quiet = { cwd: tmp, install: false, yes: true };

  it('generates secrets it can generate and leaves the rest for the user', async () => {
    const dir = join(tmp, 'wa');
    await create({ ...quiet, dir, channels: 'whatsapp', template: 'webhook' });
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    assert.ok((env.WHATSAPP_VERIFY_TOKEN ?? '').length >= 32);
    assert.ok((env.WEBHOOK_SECRET ?? '').length >= 32);
    assert.equal(env.WHATSAPP_PORT, '3000');
    assert.equal(env.WHATSAPP_ACCESS_TOKEN, '');
  });

  it('drops iMessage off macOS, and rejects unknown channels and templates', async () => {
    const dir = join(tmp, 'linux');
    await create({ ...quiet, dir, channels: 'imessage,telegram', platform: 'linux' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).textagent.channels, ['telegram']);
    await assert.rejects(
      create({ ...quiet, dir: join(tmp, 'a'), channels: 'imessage', platform: 'linux' }),
      /No usable channels/,
    );
    await assert.rejects(create({ ...quiet, dir: join(tmp, 'b'), channels: 'fax' }), /Unknown channel/);
    await assert.rejects(create({ ...quiet, dir: join(tmp, 'c'), template: 'gpt' }), /Unknown template/);
  });
});

describe('generated agent.ts', () => {
  // Inside the repo, so imports resolve to the workspace packages and the real Anthropic SDK.
  const base = join(REPO, '.tmp', `cli-test-${process.pid}`);
  after(() => rmSync(base, { recursive: true, force: true }));

  for (const template of TEMPLATES) {
    it(`typechecks for the ${template.name} template with every channel`, async () => {
      const dir = join(base, template.name);
      await mkdir(dir, { recursive: true });
      for (const [file, content] of Object.entries(
        renderFiles({ dir, channels: CHANNELS.map((c) => c.name), template: template.name, env: {}, link: REPO }),
      )) {
        writeFileSync(join(dir, file), content);
      }
      execFileSync(join(REPO, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.json')], { stdio: 'pipe' });
    });
  }
});

describe('doctor', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'textagent-doctor-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('explains when run outside a project', async () => {
    const sections = await runChecks(tmp);
    assert.match(sections[0]!.results.at(-1)!.detail!, /No package\.json/);
  });

  it('reports each missing setting, and checks webhook settings without network', async () => {
    const dir = join(tmp, 'p');
    await writeProject({
      dir,
      channels: ['telegram'],
      template: 'webhook',
      env: { WEBHOOK_URL: 'http://example.com/x', WEBHOOK_SECRET: 'x'.repeat(40) },
    });
    const sections = await runChecks(dir);
    const failures = sections.flatMap((s) => s.results.filter((r) => !r.ok).map((r) => r.name));
    assert.deepEqual(failures, ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_URL']);
  });
});

describe('tunnelUrl', () => {
  it('finds the public URL in cloudflared and ngrok output', () => {
    assert.equal(
      tunnelUrl('2026-10-04T12:00:00Z INF |  https://quiet-river-1234.trycloudflare.com  |'),
      'https://quiet-river-1234.trycloudflare.com',
    );
    assert.equal(
      tunnelUrl('{"lvl":"info","msg":"started tunnel","url":"https://ab12.ngrok-free.app"}'),
      'https://ab12.ngrok-free.app',
    );
    assert.equal(tunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), undefined);
  });
});
