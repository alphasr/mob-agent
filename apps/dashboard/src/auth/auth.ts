import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { sharedDb } from '../db/connect.ts';
import type { Db } from '../db/db.ts';
import { authAccounts, authRateLimits, authSessions, authUsers, authVerifications } from '../db/schema.ts';

export interface AuthSettings {
  /** AUTH_SECRET: signs session cookies. At least 32 random characters. */
  secret: string;
  /** AUTH_URL: the dashboard's public origin; GitHub redirects back to it. */
  baseURL: string;
  /** GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET of a GitHub OAuth app. */
  github: { clientId: string; clientSecret: string };
  /**
   * TRUSTED_IP_HEADER: where the client IP comes from, for the sign-in rate limit. It must be a header the
   * proxy in front sets itself (Vercel and the bundled Caddy set x-forwarded-for); a header clients can send
   * unchanged lets them pick a fresh "IP" per attempt. Default: x-forwarded-for.
   */
  ipHeader?: string;
}

/** GitHub's profile `login` is the username; better-auth keys the account by the numeric `id` itself. */
export function githubProfileToUser(profile: { login: string; name?: string | null }): {
  name: string;
  githubLogin: string;
} {
  return { name: profile.name || profile.login, githubLogin: profile.login };
}

/** Everything but plugins, so tests can build the same auth with better-auth's test helpers. */
export function authOptions(db: Db, settings: AuthSettings) {
  return {
    secret: settings.secret,
    baseURL: settings.baseURL,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        rateLimit: authRateLimits,
      },
    }),
    socialProviders: {
      github: {
        clientId: settings.github.clientId,
        clientSecret: settings.github.clientSecret,
        mapProfileToUser: githubProfileToUser,
        // Keeps githubLogin current after a username change.
        overrideUserInfoOnSignIn: true,
      },
    },
    user: { additionalFields: { githubLogin: { type: 'string', required: false, input: false } } },
    // GitHub is the only way in.
    emailAndPassword: { enabled: false },
    // In the database: serverless instances don't share memory.
    rateLimit: { enabled: true, storage: 'database' },
    advanced: { ipAddress: { ipAddressHeaders: [settings.ipHeader ?? 'x-forwarded-for'] } },
  } satisfies BetterAuthOptions;
}

export function createAuth(db: Db, settings: AuthSettings) {
  return betterAuth({ ...authOptions(db, settings), plugins: [nextCookies()] });
}

export type Auth = ReturnType<typeof createAuth>;

let shared: Auth | undefined;

/** Built on first use, not at import: `next build` loads route modules without the runtime env. */
export function sharedAuth(): Auth {
  shared ??= createAuth(sharedDb(), settingsFromEnv(process.env));
  return shared;
}

export function settingsFromEnv(env: Record<string, string | undefined>): AuthSettings {
  const names = ['AUTH_SECRET', 'AUTH_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'] as const;
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Set ${missing.join(', ')} for sign-in`);
  if (env.AUTH_SECRET!.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters');
  return {
    secret: env.AUTH_SECRET!,
    baseURL: env.AUTH_URL!,
    github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! },
    ...(env.TRUSTED_IP_HEADER && { ipHeader: env.TRUSTED_IP_HEADER.toLowerCase() }),
  };
}
