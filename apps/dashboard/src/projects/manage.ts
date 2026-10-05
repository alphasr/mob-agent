import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { AccessError, isUuid, requireMember } from '../auth/members.ts';
import type { Role } from '../auth/members.ts';
import type { Db } from '../db/db.ts';
import { ingestKeys, messages, projectMembers, projects } from '../db/schema.ts';
import { generateKey } from '../ingest/keys.ts';

/**
 * Everything a project page can do. Each function checks the caller's membership itself, so a
 * page or action can't forget to; ids from the browser are only ever used together with that check.
 */

/** A mistake the user can fix; its message is shown to them as is. */
export class InputError extends Error {}

export const MAX_ACTIVE_KEYS = 10;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export async function getProject(
  db: Db,
  userId: string,
  projectId: string,
): Promise<{ id: string; name: string; storeText: boolean; role: Role }> {
  const role = await requireMember(db, userId, projectId);
  const [project] = await db
    .select({ id: projects.id, name: projects.name, storeText: projects.storeText })
    .from(projects)
    .where(eq(projects.id, projectId));
  return { ...project!, role }; // requireMember found the membership, so the project exists
}

// Keys

export async function listKeys(db: Db, userId: string, projectId: string) {
  await requireMember(db, userId, projectId);
  return db
    .select({
      id: ingestKeys.id,
      prefix: ingestKeys.prefix,
      createdAt: ingestKeys.createdAt,
      revokedAt: ingestKeys.revokedAt,
    })
    .from(ingestKeys)
    .where(eq(ingestKeys.projectId, projectId))
    .orderBy(desc(ingestKeys.createdAt));
}

/** Returns the key itself, which is shown once and never stored. */
export async function createKey(db: Db, userId: string, projectId: string): Promise<{ key: string; prefix: string }> {
  await requireMember(db, userId, projectId, 'owner');
  const [active] = await db
    .select({ n: count() })
    .from(ingestKeys)
    .where(and(eq(ingestKeys.projectId, projectId), isNull(ingestKeys.revokedAt)));
  if (active!.n >= MAX_ACTIVE_KEYS) {
    throw new InputError(`A project can have ${MAX_ACTIVE_KEYS} active keys; revoke one first`);
  }
  const { key, hash, prefix } = generateKey();
  await db.insert(ingestKeys).values({ projectId, keyHash: hash, prefix });
  return { key, prefix };
}

export async function revokeKey(db: Db, userId: string, projectId: string, keyId: string): Promise<void> {
  await requireMember(db, userId, projectId, 'owner');
  if (!isUuid(keyId)) throw new InputError('No such active key');
  // Scoped to this project: a key id from another project matches nothing.
  const revoked = await db
    .update(ingestKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(ingestKeys.id, keyId), eq(ingestKeys.projectId, projectId), isNull(ingestKeys.revokedAt)))
    .returning({ id: ingestKeys.id });
  if (revoked.length === 0) throw new InputError('No such active key');
}

// Members

export async function listMembers(db: Db, userId: string, projectId: string) {
  await requireMember(db, userId, projectId);
  return db
    .select({ githubId: projectMembers.githubId, githubLogin: projectMembers.githubLogin, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.addedAt));
}

/** Resolves a GitHub username to the account's numeric id; undefined if there is no such user. */
export type GithubLookup = (login: string) => Promise<{ id: string; login: string } | undefined>;

export async function addMember(
  db: Db,
  userId: string,
  projectId: string,
  login: string,
  role: Role,
  lookup: GithubLookup,
): Promise<void> {
  await requireMember(db, userId, projectId, 'owner');
  const trimmed = login.trim().replace(/^@/, '');
  if (!GITHUB_LOGIN.test(trimmed)) throw new InputError(`"${trimmed}" isn't a GitHub username`);
  const account = await lookup(trimmed);
  if (!account) throw new InputError(`There's no GitHub user named ${trimmed}`);
  const added = await db
    .insert(projectMembers)
    .values({ projectId, githubId: account.id, githubLogin: account.login, role })
    .onConflictDoNothing()
    .returning({ githubId: projectMembers.githubId });
  if (added.length === 0) throw new InputError(`${account.login} is already a member`);
}

/** Owners remove anyone; a project always keeps at least one owner. */
export async function removeMember(db: Db, userId: string, projectId: string, githubId: string): Promise<void> {
  await requireMember(db, userId, projectId, 'owner');
  await db.transaction(async (tx) => {
    const members = await tx
      .select({ githubId: projectMembers.githubId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .for('update');
    const target = members.find((m) => m.githubId === githubId);
    if (!target) throw new InputError('No such member');
    if (target.role === 'owner' && members.filter((m) => m.role === 'owner').length === 1) {
      throw new InputError('A project needs an owner; add another owner first, or delete the project');
    }
    await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.githubId, githubId)));
  });
}

// Settings

/** Turning text off also deletes every message already stored for the project. */
export async function setStoreText(db: Db, userId: string, projectId: string, storeText: boolean): Promise<void> {
  await requireMember(db, userId, projectId, 'owner');
  await db.transaction(async (tx) => {
    await tx.update(projects).set({ storeText }).where(eq(projects.id, projectId));
    if (!storeText) await tx.delete(messages).where(eq(messages.projectId, projectId));
  });
}

/** Deletes the project and, by cascade, its keys, members, traces and messages. */
export async function deleteProject(db: Db, userId: string, projectId: string, typedName: string): Promise<void> {
  const { name, role } = await getProject(db, userId, projectId);
  if (role !== 'owner') throw new AccessError(403);
  if (typedName.trim() !== name) throw new InputError('Type the project name exactly to delete it');
  await db.delete(projects).where(eq(projects.id, projectId));
}

/** GitHub's public API; unauthenticated, which allows 60 lookups an hour per server IP. */
export const githubLookup: GithubLookup = async (login) => {
  if (!GITHUB_LOGIN.test(login)) return undefined; // never put anything else into the URL
  const response = await fetch(`https://api.github.com/users/${login}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'textagent-dashboard' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new InputError(`GitHub didn't answer (HTTP ${response.status}); try again shortly`);
  const user = (await response.json()) as { id: number; login: string }; // GitHub's documented user shape
  return { id: String(user.id), login: user.login };
};
