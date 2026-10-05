import { redirect } from 'next/navigation';
import { signedInUser } from '../../src/auth/request.ts';
import { SignInButton } from '../auth-buttons.tsx';

export default async function SignIn() {
  if (await signedInUser()) redirect('/');
  return (
    <main>
      <h1>textagent dashboard</h1>
      <p>See what your agents are doing: turns, timings, tokens and cost.</p>
      <SignInButton />
    </main>
  );
}
