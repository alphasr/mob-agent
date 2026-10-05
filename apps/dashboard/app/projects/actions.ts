'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AccessError, createProject } from '../../src/auth/members.ts';
import type { Role } from '../../src/auth/members.ts';
import { signedInUser } from '../../src/auth/request.ts';
import { sharedDb } from '../../src/db/connect.ts';
import {
  InputError,
  addMember,
  createKey,
  deleteProject,
  githubLookup,
  removeMember,
  revokeKey,
  setStoreText,
} from '../../src/projects/manage.ts';

/**
 * Thin wrappers: every rule (membership, roles, limits) lives in src/projects/manage.ts and is tested there.
 * Ids arrive from the browser and are passed through untrusted; manage.ts checks them against the session's user.
 */

export type ActionState = { error?: string; key?: string } | undefined;

async function userId(): Promise<string> {
  const user = await signedInUser();
  if (!user) redirect('/sign-in');
  return user.id;
}

async function run(projectId: string, action: (userId: string) => Promise<ActionState | void>): Promise<ActionState> {
  const id = await userId();
  try {
    const state = await action(id);
    revalidatePath(`/projects/${projectId}`, 'layout'); // every page of the project
    return state ?? {};
  } catch (error) {
    if (error instanceof InputError || error instanceof AccessError) return { error: error.message };
    throw error;
  }
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

export async function createProjectAction(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await signedInUser();
  if (!user) redirect('/sign-in');
  let projectId: string;
  try {
    projectId = await createProject(sharedDb(), user.id, user.githubLogin, text(form, 'name'));
  } catch (error) {
    if (error instanceof RangeError || error instanceof AccessError) return { error: error.message };
    throw error;
  }
  redirect(`/projects/${projectId}`); // outside the try: redirect() works by throwing
}

export async function createKeyAction(projectId: string): Promise<ActionState> {
  return run(projectId, async (u) => ({ key: (await createKey(sharedDb(), u, projectId)).key }));
}

export async function revokeKeyAction(projectId: string, keyId: string): Promise<ActionState> {
  return run(projectId, (u) => revokeKey(sharedDb(), u, projectId, keyId));
}

export async function addMemberAction(projectId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const role: Role = text(form, 'role') === 'owner' ? 'owner' : 'member';
  return run(projectId, (u) => addMember(sharedDb(), u, projectId, text(form, 'login'), role, githubLookup));
}

export async function removeMemberAction(projectId: string, githubId: string): Promise<ActionState> {
  return run(projectId, (u) => removeMember(sharedDb(), u, projectId, githubId));
}

export async function setStoreTextAction(projectId: string, storeText: boolean): Promise<ActionState> {
  return run(projectId, (u) => setStoreText(sharedDb(), u, projectId, storeText));
}

export async function deleteProjectAction(projectId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const state = await run(projectId, (u) => deleteProject(sharedDb(), u, projectId, text(form, 'name')));
  if (state?.error) return state;
  redirect('/');
}
