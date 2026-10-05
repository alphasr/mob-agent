'use client';

import { createAuthClient } from 'better-auth/react';

const authClient = createAuthClient();

export function SignInButton() {
  return (
    <button type="button" onClick={() => void authClient.signIn.social({ provider: 'github', callbackURL: '/' })}>
      Sign in with GitHub
    </button>
  );
}

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => void authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign('/sign-in') } })}
    >
      Sign out
    </button>
  );
}
