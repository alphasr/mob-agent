import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { sharedDb } from '../db/connect.ts';
import { getProject } from '../projects/manage.ts';
import { AccessError } from './members.ts';
import { sharedAuth } from './auth.ts';
import { currentUser } from './session.ts';
import type { SignedInUser } from './session.ts';

/** The signed-in user for the current page or action, from its session cookie. */
export async function signedInUser(): Promise<SignedInUser | undefined> {
  // headers() first: it marks the page per-request, so `next build` doesn't prerender it and touch the database.
  const requestHeaders = await headers();
  return currentUser(sharedAuth(), requestHeaders);
}

/**
 * For project pages and layouts: the signed-in user and their view of the project, or the response a
 * stranger gets (sign-in redirect, or 404 for projects they don't belong to).
 */
export async function projectPage(projectId: string) {
  const user = await signedInUser();
  if (!user) redirect('/sign-in');
  try {
    return { user, project: await getProject(sharedDb(), user.id, projectId) };
  } catch (error) {
    if (error instanceof AccessError) notFound();
    throw error;
  }
}
