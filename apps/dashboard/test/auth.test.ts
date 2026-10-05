import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { authOptions, githubProfileToUser, settingsFromEnv } from '../src/auth/auth.ts';
import type { AuthSettings } from '../src/auth/auth.ts';
import { createProject, requireMember } from '../src/auth/members.ts';
import { currentUser } from '../src/auth/session.ts';
import type { Db } from '../src/db/db.ts';
import { authAccounts, authRateLimits, authSessions, authVerifications } from '../src/db/schema.ts';
import { testDb } from './db.ts';

const BASE = 'http://localhost:3000';
const SETTINGS: AuthSettings = {
  secret: 'a'.repeat(32),
  baseURL: BASE,
  github: { clientId: 'gh-client-id', clientSecret: 'gh-client-secret' },
};

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await testDb()));
afterEach(() => close());

/** The production options plus better-auth's test helpers, on the test database. */
function testAuth() {
  return betterAuth({ ...authOptions(db, SETTINGS), plugins: [testUtils()] });
}

/** A user as a GitHub sign-in leaves them: user row, GitHub account row, session cookie. */
async function signIn(auth: ReturnType<typeof testAuth>, login: string, githubId: string): Promise<Headers> {
  const { test } = await auth.$context;
  const user = await test.saveUser(test.createUser({ email: `${login}@example.com`, name: login, githubLogin: login }));
  await db
    .insert(authAccounts)
    .values({ id: `acct-${login}`, accountId: githubId, providerId: 'github', userId: user.id });
  return (await test.login({ userId: user.id })).headers;
}

function post(
  auth: ReturnType<typeof testAuth>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': '203.0.113.1', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('sessions', () => {
  it('turns a session cookie into the signed-in user, stored in our auth tables', async () => {
    const auth = testAuth();
    const headers = await signIn(auth, 'ada', '101');
    const user = await currentUser(auth, headers);
    assert.equal(user?.githubLogin, 'ada');
    assert.equal(user?.name, 'ada');
    assert.equal((await db.select().from(authSessions)).length, 1);
  });

  it('treats no cookie, a forged cookie or a tampered signature as signed out', async () => {
    const auth = testAuth();
    const headers = await signIn(auth, 'ada', '101');
    const cookie = headers.get('cookie')!;
    assert.equal(await currentUser(auth, new Headers()), undefined);
    assert.equal(await currentUser(auth, new Headers({ cookie: 'better-auth.session_token=made.up' })), undefined);
    const tampered = cookie.replace(
      /(session_token=[^.;]+\.)([^;]+)/,
      (_, head: string, sig: string) => head + sig.split('').reverse().join(''),
    );
    assert.notEqual(tampered, cookie);
    assert.equal(await currentUser(auth, new Headers({ cookie: tampered })), undefined);
  });

  it('connects a session to project access through the GitHub id', async () => {
    const auth = testAuth();
    const ada = (await currentUser(auth, await signIn(auth, 'ada', '101')))!;
    const bob = (await currentUser(auth, await signIn(auth, 'bob', '202')))!;
    const project = await createProject(db, ada.id, ada.githubLogin, 'Support bot');
    assert.equal(await requireMember(db, ada.id, project, 'owner'), 'owner');
    await assert.rejects(requireMember(db, bob.id, project));
  });
});

describe('sign-in', () => {
  it('starts GitHub OAuth with our client id and a stored state', async () => {
    const response = await post(testAuth(), '/sign-in/social', { provider: 'github', callbackURL: '/' });
    assert.equal(response.status, 200);
    const { url } = (await response.json()) as { url: string };
    const authorize = new URL(url);
    assert.equal(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'gh-client-id');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${BASE}/api/auth/callback/github`);
    assert.ok(authorize.searchParams.get('state'));
    assert.equal((await db.select().from(authVerifications)).length, 1);
    assert.match(response.headers.get('set-cookie') ?? '', /better-auth\.state=/);
  });

  it('offers no email/password sign-up or sign-in', async () => {
    const auth = testAuth();
    const signUp = await post(auth, '/sign-up/email', { email: 'x@example.com', password: 'p'.repeat(12), name: 'x' });
    const signInEmail = await post(auth, '/sign-in/email', { email: 'x@example.com', password: 'p'.repeat(12) });
    assert.ok(signUp.status >= 400 && signInEmail.status >= 400, `${signUp.status} ${signInEmail.status}`);
  });

  it('rate-limits sign-in attempts per client IP, counting in the database', async () => {
    const auth = testAuth();
    const attempt = (ip: string) =>
      post(auth, '/sign-in/social', { provider: 'github', callbackURL: '/' }, { 'x-forwarded-for': ip });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt('198.51.100.7')).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal((await attempt('198.51.100.8')).status, 200, 'another visitor is unaffected');
    const keys = (await db.select().from(authRateLimits)).map((r) => r.key).sort();
    assert.deepEqual(keys, ['198.51.100.7|/sign-in/social', '198.51.100.8|/sign-in/social']);
  });

  it('refuses cookie-carrying requests from another origin (CSRF)', async () => {
    const auth = testAuth();
    const headers = await signIn(auth, 'ada', '101');
    const cookie = headers.get('cookie')!;
    const forged = await post(auth, '/sign-out', {}, { cookie, origin: 'https://evil.example' });
    assert.equal(forged.status, 403);
    assert.ok(await currentUser(auth, headers), 'still signed in');
    assert.equal((await post(auth, '/sign-out', {}, { cookie })).status, 200);
    assert.equal(await currentUser(auth, headers), undefined, 'signed out from our own origin');
  });
});

describe('settings', () => {
  it('requires every sign-in setting and a long secret', () => {
    assert.throws(() => settingsFromEnv({}), /Set AUTH_SECRET, AUTH_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET/);
    const env = { AUTH_SECRET: 's'.repeat(32), AUTH_URL: BASE, GITHUB_CLIENT_ID: 'i', GITHUB_CLIENT_SECRET: 'c' };
    assert.equal(settingsFromEnv(env).github.clientId, 'i');
    assert.throws(() => settingsFromEnv({ ...env, AUTH_SECRET: 'short' }), /at least 32/);
  });

  it('records the GitHub username, and falls back to it for a missing name', () => {
    assert.deepEqual(githubProfileToUser({ login: 'ada', name: 'Ada Lovelace' }), {
      name: 'Ada Lovelace',
      githubLogin: 'ada',
    });
    assert.deepEqual(githubProfileToUser({ login: 'ada', name: null }), { name: 'ada', githubLogin: 'ada' });
  });
});
