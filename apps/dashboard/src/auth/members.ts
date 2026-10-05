import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/db.ts';
import { authAccounts, projectMembers, projects } from '../db/schema.ts';

export type Role = 'owner' | 'member';

/** A request the signed-in user may not make. `status` is safe to send to the browser as is. */
export class AccessError extends Error {
  readonly status: 403 | 404;
  constructor(status: 403 | 404) {
    super(status === 404 ? 'not found' : 'only project owners can do this');
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from the browser must be checked before they reach a uuid column, where anything else is a Postgres error. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The signed-in user's GitHub id: what `project_members` is keyed by. */
export async function githubIdOf(db: Db, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ githubId: authAccounts.accountId })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, 'github')))
    .limit(1);
  return row?.githubId;
}

/**
 * The gate in front of every project page and action. `projectId` comes from the URL and is untrusted:
 * anything but a project the user belongs to is a 404, so ids don't reveal which projects exist.
 * A member asking for an owner-only action gets 403. Returns the user's role.
 */
export async function requireMember(db: Db, userId: string, projectId: string, needs: Role = 'member'): Promise<Role> {
  // Not a uuid would make Postgres throw (a 500); it can't be a project either.
  if (!isUuid(projectId)) throw new AccessError(404);
  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(
      authAccounts,
      and(eq(authAccounts.accountId, projectMembers.githubId), eq(authAccounts.providerId, 'github')),
    )
    .where(and(eq(projectMembers.projectId, projectId), eq(authAccounts.userId, userId)))
    .limit(1);
  if (!row) throw new AccessError(404);
  if (needs === 'owner' && row.role !== 'owner') throw new AccessError(403);
  return row.role;
}

/** The user's projects, oldest first. */
export async function listProjects(db: Db, userId: string): Promise<Array<{ id: string; name: string; role: Role }>> {
  const githubId = await githubIdOf(db, userId);
  if (!githubId) return [];
  return db
    .select({ id: projects.id, name: projects.name, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.githubId, githubId))
    .orderBy(asc(projects.createdAt));
}

/** A new project, owned by the user who creates it. */
export async function createProject(db: Db, userId: string, githubLogin: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) throw new RangeError('A project name is 1 to 100 characters');
  const githubId = await githubIdOf(db, userId);
  if (!githubId) throw new AccessError(403); // signed in some other way; every user here comes from GitHub
  return db.transaction(async (tx) => {
    const [project] = await tx.insert(projects).values({ name: trimmed }).returning({ id: projects.id });
    const id = project!.id; // returning() yields the one inserted row
    await tx.insert(projectMembers).values({ projectId: id, githubId, githubLogin, role: 'owner' });
    return id;
  });
}
