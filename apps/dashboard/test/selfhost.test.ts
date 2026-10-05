import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { betterAuth } from 'better-auth';
import { sql } from 'drizzle-orm';
import { authOptions, settingsFromEnv } from '../src/auth/auth.ts';
import type { Db } from '../src/db/db.ts';
import { withMigrationLock } from '../src/db/migrate.ts';
import { startRetention } from '../src/retention.ts';
import { startServer } from '../src/server/start.ts';
import { testDb } from './db.ts';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await testDb()));
afterEach(() => close());

async function advisoryLocks(): Promise<number> {
  const result = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
  return (result as unknown as { rows: Array<{ n: number }> }).rows[0]!.n; // PGlite's execute result shape
}

describe('withMigrationLock', () => {
  it('holds an advisory lock while migrating and releases it afterwards', async () => {
    let during = -1;
    await withMigrationLock(db, async () => {
      during = await advisoryLocks();
    });
    assert.equal(during, 1);
    assert.equal(await advisoryLocks(), 0);
  });

  it('releases the lock when a migration fails, and reports the failure', async () => {
    await assert.rejects(
      withMigrationLock(db, () => Promise.reject(new Error('bad migration'))),
      /bad migration/,
    );
    assert.equal(await advisoryLocks(), 0);
  });
});

describe('startRetention', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }));
  afterEach(() => mock.timers.reset());

  it('prunes soon after start, then daily; a failed run is reported and the schedule goes on', async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const stop = startRetention(
      async () => {
        runs++;
        if (runs === 2) throw new Error('database down');
      },
      { firstRunMs: 1_000, everyMs: 10_000, onError: (e) => errors.push(e) },
    );
    mock.timers.tick(999);
    assert.equal(runs, 0);
    mock.timers.tick(1);
    assert.equal(runs, 1);
    mock.timers.tick(10_000);
    await Promise.resolve(); // let the failed run's rejection reach onError
    assert.equal(runs, 2);
    assert.match(String(errors[0]), /database down/);
    mock.timers.tick(10_000);
    assert.equal(runs, 3);
    stop();
    mock.timers.tick(50_000);
    assert.equal(runs, 3);
  });
});

describe('startServer', () => {
  it('does nothing on Vercel, which migrates at deploy and prunes by cron', async () => {
    await startServer({ VERCEL: '1' }); // no DATABASE_URL needed, nothing started
  });

  it('refuses to start a self-hosted server without a database', async () => {
    await assert.rejects(startServer({}), /Set DATABASE_URL/);
  });
});

describe('TRUSTED_IP_HEADER', () => {
  const base = {
    AUTH_SECRET: 's'.repeat(32),
    AUTH_URL: 'http://localhost:3000',
    GITHUB_CLIENT_ID: 'i',
    GITHUB_CLIENT_SECRET: 'c',
  };

  it('is optional and normalised', () => {
    assert.equal(settingsFromEnv(base).ipHeader, undefined);
    assert.equal(settingsFromEnv({ ...base, TRUSTED_IP_HEADER: 'X-Real-IP' }).ipHeader, 'x-real-ip');
  });

  it('keys the sign-in rate limit by the trusted header and ignores a spoofed x-forwarded-for', async () => {
    const auth = betterAuth(authOptions(db, settingsFromEnv({ ...base, TRUSTED_IP_HEADER: 'x-real-ip' })));
    const attempt = (realIp: string, spoofed: string) =>
      auth
        .handler(
          new Request('http://localhost:3000/api/auth/sign-in/social', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://localhost:3000',
              'x-real-ip': realIp,
              'x-forwarded-for': spoofed,
            },
            body: '{"provider":"github","callbackURL":"/"}',
          }),
        )
        .then((r) => r.status);
    // Same real client, a fresh spoofed address every time: still limited after 3.
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(await attempt('192.0.2.10', `198.51.100.${i}`));
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal(await attempt('192.0.2.11', '198.51.100.9'), 200, 'another real client is unaffected');
  });
});
