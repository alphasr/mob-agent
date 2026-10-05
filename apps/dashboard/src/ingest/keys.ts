import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/db.ts';
import { ingestKeys, projects } from '../db/schema.ts';

export interface NewKey {
  /** Shown once; only its hash is stored. */
  key: string;
  hash: string;
  /** Enough to tell keys apart in a list, too little to use. */
  prefix: string;
}

export function generateKey(): NewKey {
  const key = `ta_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 10) };
}

/** Keys are 256 random bits, so a fast hash is enough: there is nothing to brute-force. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The project a key belongs to and whether it keeps message text, or undefined for an unknown or revoked key. */
export async function findProject(db: Db, key: string): Promise<{ projectId: string; storeText: boolean } | undefined> {
  const [row] = await db
    .select({ projectId: ingestKeys.projectId, storeText: projects.storeText })
    .from(ingestKeys)
    .innerJoin(projects, eq(projects.id, ingestKeys.projectId))
    .where(and(eq(ingestKeys.keyHash, hashKey(key)), isNull(ingestKeys.revokedAt)))
    .limit(1);
  return row;
}

/** Until sign-in exists (10d3): make a project and its first key. */
export async function createProjectWithKey(db: Db, name: string): Promise<{ projectId: string; key: string }> {
  const { key, hash, prefix } = generateKey();
  const projectId = await db.transaction(async (tx) => {
    const [project] = await tx.insert(projects).values({ name }).returning({ id: projects.id });
    const id = project!.id; // returning() yields the one inserted row
    await tx.insert(ingestKeys).values({ projectId: id, keyHash: hash, prefix });
    return id;
  });
  return { projectId, key };
}
