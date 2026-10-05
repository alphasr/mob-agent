import type { Auth } from './auth.ts';

export interface SignedInUser {
  id: string;
  name: string;
  githubLogin: string;
}

/** The user behind the request's session cookie, verified by better-auth; undefined when signed out. */
export async function currentUser(auth: Pick<Auth, 'api'>, headers: Headers): Promise<SignedInUser | undefined> {
  const session = await auth.api.getSession({ headers });
  if (!session) return undefined;
  const { id, name, githubLogin } = session.user;
  return { id, name, githubLogin: githubLogin ?? name };
}
