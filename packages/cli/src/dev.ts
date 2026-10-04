import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { styleText } from 'node:util';
import { loadProject } from './project.ts';

/** Run the agent with live reload; for WhatsApp, also open a public tunnel when one is installed. */
export async function dev(dir: string, options: { tunnel?: boolean } = {}): Promise<void> {
  const project = await loadProject(dir);
  const children: ChildProcess[] = [];
  const stopAll = () => {
    for (const child of children) child.kill('SIGTERM');
  };
  process.once('SIGINT', stopAll);
  process.once('SIGTERM', stopAll);

  if (project.channels.includes('whatsapp') && options.tunnel !== false) {
    const port = Number(project.env.WHATSAPP_PORT || 3000);
    const tunnel = startTunnel(port, (url) => {
      console.log(styleText('green', `\nWhatsApp webhook URL: ${url}/webhook`));
      console.log(
        `Paste it in the Meta app dashboard (WhatsApp → Configuration → Webhook) with verify token ${styleText('bold', project.env.WHATSAPP_VERIFY_TOKEN ?? '(see .env)')}, and subscribe to "messages".\n`,
      );
    });
    if (tunnel) children.push(tunnel);
    else {
      console.log(
        styleText(
          'yellow',
          `WhatsApp needs a public URL. Install cloudflared (brew install cloudflared) or ngrok, or expose port ${port} yourself.`,
        ),
      );
    }
  }

  const agent = spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', project.entry], {
    cwd: dir,
    stdio: 'inherit',
  });
  children.push(agent);
  await new Promise<void>((resolve) => agent.on('exit', () => resolve()));
  stopAll();
}

/** Start cloudflared or ngrok if installed; returns undefined when neither is. */
function startTunnel(port: number, onUrl: (url: string) => void): ChildProcess | undefined {
  const target = `http://localhost:${port}`;
  let child: ChildProcess;
  if (findExecutable('cloudflared')) {
    child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', target], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else if (findExecutable('ngrok')) {
    child = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    return undefined;
  }
  let announced = false;
  const scan = (chunk: Buffer) => {
    const url = tunnelUrl(chunk.toString());
    if (url && !announced) {
      announced = true;
      onUrl(url);
    }
  };
  child.stdout?.on('data', scan);
  child.stderr?.on('data', scan);
  return child;
}

/** The public URL in cloudflared or ngrok output, if this chunk contains it. */
export function tunnelUrl(output: string): string | undefined {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output)?.[0] ?? /"url":"(https:\/\/[^"]+)"/.exec(output)?.[1];
}

function findExecutable(name: string): boolean {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const n of names) {
      try {
        accessSync(join(dir, n), constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}
