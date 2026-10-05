import { sharedDb } from '../db/connect.ts';
import { migrateDatabase } from '../db/migrate.ts';
import { prune, startRetention } from '../retention.ts';

/**
 * What a long-running (self-hosted) server does once at startup: bring the schema up to date before taking
 * traffic, then keep retention running. Vercel has neither a long-running process nor a need: its deploys
 * run migrations explicitly and its cron calls /v1/cron/prune.
 */
export async function startServer(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (env.VERCEL) return;
  const url = env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to the Postgres connection string');
  await migrateDatabase(url);
  console.log('textagent dashboard: database schema is up to date');
  startRetention(async () => {
    const deleted = await prune(sharedDb());
    console.log(`textagent dashboard: retention deleted ${deleted.traces} traces, ${deleted.messages} messages`);
  });
}
