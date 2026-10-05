import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AccessError, createProject, listProjects, requireMember } from '../src/auth/members.ts';
import type { Db } from '../src/db/db.ts';
import { authAccounts, authUsers, projectMembers, projects } from '../src/db/schema.ts';
import { signedIn as signedInAs, testDb } from './db.ts';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await testDb()));
afterEach(() => close());

const signedIn = (name: string, githubId: string) => signedInAs(db, name, githubId);

const status = (expected: number) => (error: unknown) => error instanceof AccessError && error.status === expected;

describe('projects and members', () => {
  it('makes the creator the owner and lists only the user’s own projects', async () => {
    const ada = await signedIn('ada', '101');
    const bob = await signedIn('bob', '202');
    const id = await createProject(db, ada, 'ada', '  Support bot  ');
    await createProject(db, bob, 'bob', 'Bob’s bot');

    assert.deepEqual(await listProjects(db, ada), [{ id, name: 'Support bot', role: 'owner' }]);
    assert.equal(await requireMember(db, ada, id, 'owner'), 'owner');
    await assert.rejects(createProject(db, ada, 'ada', '   '), RangeError);
    await assert.rejects(createProject(db, ada, 'ada', 'x'.repeat(101)), RangeError);
  });

  it('answers 404 for other people’s projects, unknown ids and malformed ids alike', async () => {
    const ada = await signedIn('ada', '101');
    const bob = await signedIn('bob', '202');
    const adas = await createProject(db, ada, 'ada', 'private');

    await assert.rejects(requireMember(db, bob, adas), status(404));
    await assert.rejects(requireMember(db, bob, crypto.randomUUID()), status(404));
    for (const bad of ['', 'not-a-uuid', `${adas}' or '1'='1`, '../etc']) {
      await assert.rejects(requireMember(db, ada, bad), status(404), JSON.stringify(bad));
    }
  });

  it('lets members view but not act as owners', async () => {
    const ada = await signedIn('ada', '101');
    const bob = await signedIn('bob', '202');
    const id = await createProject(db, ada, 'ada', 'shared');
    await db.insert(projectMembers).values({ projectId: id, githubId: '202', githubLogin: 'bob', role: 'member' });

    assert.equal(await requireMember(db, bob, id), 'member');
    await assert.rejects(requireMember(db, bob, id, 'owner'), status(403));
    assert.deepEqual(
      (await listProjects(db, bob)).map((p) => p.role),
      ['member'],
    );
  });

  it('makes someone added before their first sign-in a member as soon as they sign in', async () => {
    const ada = await signedIn('ada', '101');
    const id = await createProject(db, ada, 'ada', 'shared');
    await db.insert(projectMembers).values({ projectId: id, githubId: '303', githubLogin: 'cy', role: 'member' });

    const cy = await signedIn('cy', '303');
    assert.equal(await requireMember(db, cy, id), 'member');
  });

  it('matches GitHub accounts only, never another provider’s account with the same id', async () => {
    const ada = await signedIn('ada', '101');
    const id = await createProject(db, ada, 'ada', 'p');
    await db.insert(authUsers).values({ id: 'mallory', name: 'm', email: 'm@example.com' });
    await db.insert(authAccounts).values({ id: 'acct-m', accountId: '101', providerId: 'email', userId: 'mallory' });

    await assert.rejects(requireMember(db, 'mallory', id), status(404));
    assert.deepEqual(await listProjects(db, 'mallory'), []);
    await assert.rejects(createProject(db, 'mallory', 'm', 'x'), status(403));
  });

  it('removes members with their project, and defaults to storing message text', async () => {
    const ada = await signedIn('ada', '101');
    const id = await createProject(db, ada, 'ada', 'p');
    const [row] = await db.select().from(projects);
    assert.equal(row!.storeText, true);
    await db.delete(projects);
    assert.equal((await db.select().from(projectMembers)).length, 0);
    await assert.rejects(requireMember(db, ada, id), status(404));
  });
});
