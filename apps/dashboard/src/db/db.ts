import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema.ts';

/** Any Drizzle Postgres database with this schema: node-postgres in production, PGlite in tests and self-host. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
