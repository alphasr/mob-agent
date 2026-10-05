import { sql } from 'drizzle-orm';
import { sharedDb } from '../../src/db/connect.ts';

/** For container healthchecks and load balancers: 200 when the database answers, 503 otherwise. */
export async function GET(): Promise<Response> {
  try {
    await sharedDb().execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
