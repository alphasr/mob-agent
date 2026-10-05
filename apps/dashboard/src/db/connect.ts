import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Db } from './db.ts';
import * as schema from './schema.ts';

export function connect(url: string): { db: Db; close: () => Promise<void> } {
  const pool = createPool(url);
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

/**
 * pg emits 'error' when the server drops an idle connection (Neon does when it scales to zero).
 * Without a listener, Node treats that as uncaught and the whole server exits; the pool reconnects on its own.
 */
export function createPool(url: string): Pool {
  const pool = new Pool({ connectionString: url });
  pool.on('error', (error) => console.error(`Postgres connection lost: ${error.message}`));
  return pool;
}

let shared: Db | undefined;

/** One pool per server process (or warm serverless instance), from DATABASE_URL. */
export function sharedDb(): Db {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Set DATABASE_URL to the Postgres connection string');
    shared = connect(url).db;
  }
  return shared;
}
