// Text this Mac from your phone and get an echo back.
//
//   ALLOW=+15551234567 node examples/imessage-echo.ts
//
// Needs Full Disk Access for your terminal (to read Messages) and, on the first
// reply, approving the "control Messages" prompt (to send).
import { Agent, SqliteStore } from '@textagent/core';
import { imessage } from '@textagent/imessage';

const allowed = new Set((process.env.ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean));
if (allowed.size === 0) {
  console.error('Set ALLOW to the phone numbers or emails the agent may answer, e.g. ALLOW=+15551234567');
  process.exit(1);
}

const agent = new Agent({
  channels: [imessage()],
  store: new SqliteStore('imessage-echo.sqlite'),
  allow: (msg) => allowed.has(msg.sender.id),
});

agent.on('message', async (ctx) => {
  const turns = (await ctx.history()).filter((e) => e.role === 'user').length;
  await ctx.reply(`echo #${turns}: ${ctx.text}`);
});

agent.on('event', (e) => {
  const detail = 'error' in e ? ` ${String(e.error)}` : '';
  console.log(e.at.toISOString(), e.type + detail);
});

await agent.start();
console.log(`Listening on iMessage for ${[...allowed].join(', ')}. Ctrl+C to stop.`);
process.on('SIGINT', () => void agent.stop().then(() => process.exit(0)));
