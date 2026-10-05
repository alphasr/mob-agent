import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../src/db/db.ts';
import * as schema from '../src/db/schema.ts';
import { authAccounts, authUsers } from '../src/db/schema.ts';

export const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

/** A fresh in-memory Postgres with every migration applied. Close it in `afterEach`. */
export async function testDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => client.close() };
}

/** What better-auth writes when someone signs in with GitHub. Returns the user id. */
export async function signedIn(db: Db, name: string, githubId: string): Promise<string> {
  const userId = `user-${name}`;
  await db.insert(authUsers).values({ id: userId, name, email: `${name}@example.com`, githubLogin: name });
  await db.insert(authAccounts).values({ id: `acct-${name}`, accountId: githubId, providerId: 'github', userId });
  return userId;
}
