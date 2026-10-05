import { redirect } from 'next/navigation';
import { listProjects } from '../src/auth/members.ts';
import { signedInUser } from '../src/auth/request.ts';
import { sharedDb } from '../src/db/connect.ts';
import { SignOutButton } from './auth-buttons.tsx';
import { createProjectAction } from './projects/actions.ts';
import { ActionForm } from './projects/forms.tsx';

export default async function Home() {
  const user = await signedInUser();
  if (!user) redirect('/sign-in');
  const projects = await listProjects(sharedDb(), user.id);
  return (
    <main>
      <p>
        Signed in as {user.githubLogin} <SignOutButton />
      </p>
      <h1>Projects</h1>
      {projects.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <a href={`/projects/${p.id}`}>{p.name}</a> ({p.role})
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={createProjectAction} submit="Create project">
        <input name="name" placeholder="Project name" maxLength={100} required />{' '}
      </ActionForm>
    </main>
  );
}
