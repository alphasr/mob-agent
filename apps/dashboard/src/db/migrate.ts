import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { Db } from './db.ts';
import * as schema from './schema.ts';

/** Any constant shared by every replica; identifies "the textagent migration" among advisory locks. */
const MIGRATION_LOCK = 7_420_501;

/**
 * Next.js runs the server from the app folder (`next start`, and the standalone server.js in the image),
 * which ships `drizzle/`. Not `new URL(..., import.meta.url)`: the bundler would try to import the folder.
 */
export const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

/**
 * Run `apply` holding a Postgres advisory lock, so replicas starting together migrate one at a time
 * (the second then finds nothing to do). The lock belongs to a connection: `db` must be a single one.
 */
export async function withMigrationLock(db: Db, apply: () => Promise<void>): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK})`);
  try {
    await apply();
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK})`);
  }
}

/** Bring the database at `url` up to date, on one dedicated connection (a pool could split lock and work). */
export async function migrateDatabase(url: string, folder: string = MIGRATIONS_FOLDER): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const db = drizzle(client, { schema });
    await withMigrationLock(db, () => migrate(db, { migrationsFolder: folder }));
  } finally {
    await client.end();
  }
}
