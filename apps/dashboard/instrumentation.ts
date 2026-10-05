// Next.js calls register() once when a server process starts (never during `next build`).
export async function register(): Promise<void> {
  // The edge runtime can't open Postgres connections; only the Node.js server runs startup work.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startServer } = await import('./src/server/start.ts');
  await startServer();
}
