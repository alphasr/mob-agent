import { parseArgs } from 'node:util';
import { create } from './create.ts';
import { dev } from './dev.ts';
import { doctor } from './doctor.ts';

const HELP = `textagent: build agents people can text

Usage:
  textagent create [dir]   Create a new agent project
      --channels <list>      telegram,whatsapp,email,imessage
      --template <name>      echo | claude | support | booking | assistant | webhook
      --dashboard            Send traces to a textagent dashboard
      --yes                  Use defaults; don't ask questions
      --force                Write into a non-empty directory
      --no-install           Skip installing dependencies
  textagent dev            Run the agent with live reload (and a tunnel for WhatsApp)
      --no-tunnel            Don't start cloudflared/ngrok
  textagent doctor         Check credentials and permissions (sends nothing)
`;

/** Entry point shared by the `textagent` and `create-textagent` binaries. Returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    console.error(`textagent needs Node.js 24 or newer; this is ${process.versions.node}. Upgrade at nodejs.org.`);
    return 1;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      channels: { type: 'string' },
      template: { type: 'string' },
      dashboard: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      force: { type: 'boolean' },
      'no-install': { type: 'boolean' },
      'no-tunnel': { type: 'boolean' },
      link: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;

  try {
    switch (command) {
      case 'create':
        await create({
          ...(rest[0] && { dir: rest[0] }),
          ...(values.channels !== undefined && { channels: values.channels }),
          ...(values.template !== undefined && { template: values.template }),
          ...(values.dashboard !== undefined && { dashboard: values.dashboard }),
          ...(values.link !== undefined && { link: values.link }),
          yes: values.yes ?? false,
          force: values.force ?? false,
          install: !values['no-install'],
        });
        return 0;
      case 'dev':
        await dev(process.cwd(), { tunnel: !values['no-tunnel'] });
        return 0;
      case 'doctor':
        return (await doctor(process.cwd())) ? 0 : 1;
      default:
        console.log(HELP);
        return command === undefined || values.help ? 0 : 1;
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
