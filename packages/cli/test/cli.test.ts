import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import { CHANNELS, DASHBOARD, TEMPLATES } from '../src/catalog.ts';
import { create } from '../src/create.ts';
import { tunnelUrl } from '../src/dev.ts';
import { runChecks } from '../src/doctor.ts';
import { packageName, renderAgent, renderFiles, writeProject } from '../src/scaffold.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('catalog', () => {
  it('generated code reads exactly the env vars each channel and the dashboard declare', () => {
    for (const spec of [...CHANNELS, { name: 'dashboard', ...DASHBOARD }]) {
      const used = new Set([...spec.code.matchAll(/env\('(\w+)'\)|process\.env\.(\w+)/g)].map((m) => m[1] ?? m[2]));
      assert.deepEqual([...used].sort(), spec.env.map((v) => v.name).sort(), spec.name);
    }
  });
});

describe('catalog: templates', () => {
  it('generated code reads exactly the env vars each template declares', () => {
    for (const template of TEMPLATES) {
      const code = renderAgent({ channels: [], template: template.name });
      const used = new Set([...code.matchAll(/env\('(\w+)'\)|process\.env\.(\w+)/g)].map((m) => m[1] ?? m[2]));
      used.delete('ALLOWED_SENDERS'); // every template reads it
      if (template.env.some((v) => v.name === 'ANTHROPIC_API_KEY')) used.add('ANTHROPIC_API_KEY'); // read by the SDK
      assert.deepEqual([...used].sort(), template.env.map((v) => v.name).sort(), template.name);
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

  it('adds the dashboard exporter on request, with a generated hash secret', async () => {
    const dir = join(tmp, 'dash');
    await create({ ...quiet, dir, dashboard: true });
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    assert.ok((env.TEXTAGENT_HASH_SECRET ?? '').length >= 32);
    assert.equal(env.TEXTAGENT_KEY, '');
    assert.equal(parseEnv(readFileSync(join(dir, '.env.example'), 'utf8')).TEXTAGENT_HASH_SECRET, '');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.textagent.dashboard, true);
    assert.ok('@textagent/cloud' in pkg.dependencies);
    const agent = readFileSync(join(dir, 'agent.ts'), 'utf8');
    assert.match(agent, /agent\.on\('event', traces\)/);
    assert.ok(agent.indexOf('await agent.stop()') < agent.indexOf('await traces.close()'), 'close after stop');
  });

  it('ships the Claude tool loop with Claude templates, unchanged from the package', async () => {
    const dir = join(tmp, 'claude');
    await create({ ...quiet, dir, template: 'claude' });
    const shipped = readFileSync(join(dir, 'claude.ts'), 'utf8');
    assert.equal(shipped, readFileSync(new URL('../templates/claude.ts', import.meta.url), 'utf8'));
    assert.match(readFileSync(join(dir, 'agent.ts'), 'utf8'), /import \{ reply \} from '\.\/claude\.ts';/);
    const echo = join(tmp, 'echo-only');
    await create({ ...quiet, dir: echo });
    assert.throws(() => readFileSync(join(echo, 'claude.ts')), /ENOENT/);
  });

  it('leaves the dashboard out by default', async () => {
    const dir = join(tmp, 'plain');
    await create({ ...quiet, dir });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.textagent.dashboard, undefined);
    assert.ok(!readFileSync(join(dir, 'agent.ts'), 'utf8').includes('exporter'));
    assert.ok(!readFileSync(join(dir, '.env'), 'utf8').includes('TEXTAGENT_'));
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

  it('typechecks with the dashboard exporter', async () => {
    const dir = join(base, 'dashboard');
    await mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(
      renderFiles({ dir, channels: ['telegram'], template: 'webhook', dashboard: true, env: {}, link: REPO }),
    )) {
      writeFileSync(join(dir, file), content);
    }
    execFileSync(join(REPO, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.json')], { stdio: 'pipe' });
  });
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

describe('doctor: dashboard', () => {
  // Inside the repo, so the project resolves @textagent/cloud from the workspace.
  const base = join(REPO, '.tmp', `cli-doctor-${process.pid}`);
  after(() => rmSync(base, { recursive: true, force: true }));

  async function dashboardResults(name: string, env: Record<string, string>) {
    const dir = await writeProject({ dir: join(base, name), channels: [], template: 'echo', dashboard: true, env });
    const sections = await runChecks(dir);
    return sections.find((s) => s.title === 'Dashboard')!.results;
  }
  const good = {
    TEXTAGENT_INGEST_URL: 'https://dash.example.com/',
    TEXTAGENT_KEY: 'k',
    TEXTAGENT_HASH_SECRET: 'h'.repeat(43),
  };

  it('passes valid settings without sending anything', async () => {
    assert.deepEqual(await dashboardResults('good', good), [
      { name: 'Dashboard settings', ok: true, detail: 'https://dash.example.com' },
    ]);
  });

  it('reports missing settings, plain http and a short hash secret', async () => {
    const missing = await dashboardResults('missing', { ...good, TEXTAGENT_KEY: '' });
    assert.deepEqual(
      missing.map((r) => r.name),
      ['TEXTAGENT_KEY'],
    );
    const [http] = await dashboardResults('http', { ...good, TEXTAGENT_INGEST_URL: 'http://dash.example.com' });
    assert.match(http!.detail!, /must be https/);
    const [short] = await dashboardResults('short', { ...good, TEXTAGENT_HASH_SECRET: 'short' });
    assert.match(short!.detail!, /at least 32 characters/);
  });
});

describe('doctor: support', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'textagent-doctor-support-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('flags a handoff channel the agent does not use, before any network check', async () => {
    const dir = await writeProject({
      dir: join(tmp, 'p'),
      channels: ['telegram'],
      template: 'support',
      env: { ANTHROPIC_API_KEY: 'k', OPERATOR_CHANNEL: 'whatsapp', OPERATOR_TO: '42', TELEGRAM_BOT_TOKEN: '1:a' },
    });
    const section = (await runChecks(dir)).find((s) => s.title === 'Customer support template')!;
    assert.deepEqual(
      section.results.map((r) => [r.name, r.ok]),
      [['OPERATOR_CHANNEL', false]],
    );
    assert.match(section.results[0]!.fix!, /telegram/);
  });
});

describe('doctor: booking', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'textagent-doctor-booking-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("checks booking.config.json with the project's own booking.ts", async () => {
    const dir = await writeProject({
      dir: join(tmp, 'p'),
      channels: ['telegram'],
      template: 'booking',
      env: { ANTHROPIC_API_KEY: 'k', TELEGRAM_BOT_TOKEN: '1:a' },
    });
    const section = async () => (await runChecks(dir)).find((s) => s.title === 'Booking template')!;
    const ok = await section();
    assert.deepEqual(ok.results[0], {
      name: 'booking.config.json',
      ok: true,
      detail: '30-minute slots, Europe/London',
    });

    const config = JSON.parse(readFileSync(join(dir, 'booking.config.json'), 'utf8'));
    writeFileSync(join(dir, 'booking.config.json'), JSON.stringify({ ...config, timezone: 'Mars/Olympus' }));
    const broken = await section();
    assert.deepEqual(
      broken.results.map((r) => [r.name, r.ok, r.detail]),
      [['booking.config.json', false, 'booking config: unknown timezone "Mars/Olympus"']],
      'no API check while the config is broken',
    );
  });
});

describe('doctor: assistant', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'textagent-doctor-assistant-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('requires ALLOWED_SENDERS and a real TIMEZONE', async () => {
    const env = { ANTHROPIC_API_KEY: 'k', TELEGRAM_BOT_TOKEN: '1:a', TIMEZONE: 'Mars/Olympus', ALLOWED_SENDERS: '' };
    const plan = { dir: join(tmp, 'p'), channels: ['telegram'] as const, template: 'assistant' as const };
    const dir = await writeProject({ ...plan, channels: [...plan.channels], env });
    const sections = await runChecks(dir);
    const senders = sections[0]!.results.find((r) => r.name === 'ALLOWED_SENDERS');
    assert.equal(senders?.ok, false);
    assert.match(senders!.detail!, /refuses to start/);
    const template = () => sections.find((s) => s.title === 'Personal assistant template')!.results;
    assert.deepEqual(
      template().map((r) => [r.name, r.ok]),
      [['TIMEZONE', false]],
    );

    await writeProject(
      { ...plan, channels: [...plan.channels], env: { ...env, TIMEZONE: 'Asia/Kolkata', ALLOWED_SENDERS: '42' } },
      { force: true },
    );
    const fixed = await runChecks(dir);
    assert.equal(
      fixed[0]!.results.some((r) => r.name === 'ALLOWED_SENDERS'),
      false,
    );
    assert.deepEqual(fixed.find((s) => s.title === 'Personal assistant template')!.results[0], {
      name: 'TIMEZONE',
      ok: true,
      detail: 'Asia/Kolkata',
    });
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
