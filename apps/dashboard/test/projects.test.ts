import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { AccessError, createProject, requireMember } from '../src/auth/members.ts';
import type { Db } from '../src/db/db.ts';
import { ingestKeys, messages, projectMembers, projects, traces } from '../src/db/schema.ts';
import { findProject } from '../src/ingest/keys.ts';
import {
  InputError,
  MAX_ACTIVE_KEYS,
  addMember,
  createKey,
  deleteProject,
  getProject,
  githubLookup,
  listKeys,
  listMembers,
  removeMember,
  revokeKey,
  setStoreText,
} from '../src/projects/manage.ts';
import type { GithubLookup } from '../src/projects/manage.ts';
import { signedIn, testDb } from './db.ts';

const HASH = 'h'.repeat(43);

let db: Db;
let close: () => Promise<void>;
let owner: string;
let member: string;
let outsider: string;
let project: string;

beforeEach(async () => {
  ({ db, close } = await testDb());
  owner = await signedIn(db, 'ada', '101');
  member = await signedIn(db, 'bob', '202');
  outsider = await signedIn(db, 'eve', '666');
  project = await createProject(db, owner, 'ada', 'Support bot');
  await db.insert(projectMembers).values({ projectId: project, githubId: '202', githubLogin: 'bob', role: 'member' });
});
afterEach(() => close());

const github: Record<string, { id: string; login: string }> = {
  cy: { id: '303', login: 'cy' },
  Dee: { id: '404', login: 'Dee' },
};
let lookups: string[] = [];
const fakeLookup: GithubLookup = async (login) => {
  lookups.push(login);
  return github[login];
};

const is = (status: 403 | 404) => (error: unknown) => error instanceof AccessError && error.status === status;
const says = (pattern: RegExp) => (error: unknown) => error instanceof InputError && pattern.test(error.message);

describe('who may do what', () => {
  const ownerOnly: Array<[string, (userId: string) => Promise<unknown>]> = [
    ['createKey', (u) => createKey(db, u, project)],
    ['revokeKey', (u) => revokeKey(db, u, project, crypto.randomUUID())],
    ['addMember', (u) => addMember(db, u, project, 'cy', 'member', fakeLookup)],
    ['removeMember', (u) => removeMember(db, u, project, '202')],
    ['setStoreText', (u) => setStoreText(db, u, project, false)],
    ['deleteProject', (u) => deleteProject(db, u, project, 'Support bot')],
  ];
  const anyMember: Array<[string, (userId: string) => Promise<unknown>]> = [
    ['getProject', (u) => getProject(db, u, project)],
    ['listKeys', (u) => listKeys(db, u, project)],
    ['listMembers', (u) => listMembers(db, u, project)],
  ];

  for (const [name, action] of ownerOnly) {
    it(`${name}: 404 for outsiders, 403 for members`, async () => {
      await assert.rejects(action(outsider), is(404));
      await assert.rejects(action(member), is(403));
      assert.equal((await db.select().from(projects)).length, 1, 'nothing deleted');
    });
  }
  for (const [name, action] of anyMember) {
    it(`${name}: 404 for outsiders, allowed for members`, async () => {
      await assert.rejects(action(outsider), is(404));
      await action(member);
    });
  }
});

describe('keys', () => {
  it('creates a working key shown once, lists it by prefix, and revokes it', async () => {
    const { key, prefix } = await createKey(db, owner, project);
    assert.deepEqual(await findProject(db, key), { projectId: project, storeText: true });
    const [listed] = await listKeys(db, member, project);
    assert.equal(listed!.prefix, prefix);
    assert.ok(!JSON.stringify(await listKeys(db, owner, project)).includes(key), 'the key itself is never listed');

    await revokeKey(db, owner, project, listed!.id);
    assert.equal(await findProject(db, key), undefined);
    await assert.rejects(revokeKey(db, owner, project, listed!.id), says(/No such active key/));
  });

  it(`allows ${MAX_ACTIVE_KEYS} active keys; revoked ones don't count`, async () => {
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) await createKey(db, owner, project);
    await assert.rejects(createKey(db, owner, project), says(/10 active keys/));
    const [first] = await listKeys(db, owner, project);
    await revokeKey(db, owner, project, first!.id);
    await createKey(db, owner, project);
  });

  it('cannot revoke another project’s key through this project', async () => {
    const other = await createProject(db, owner, 'ada', 'Other');
    const { key } = await createKey(db, owner, other);
    const [otherKey] = await listKeys(db, owner, other);
    await assert.rejects(revokeKey(db, owner, project, otherKey!.id), says(/No such active key/));
    await assert.rejects(revokeKey(db, owner, project, 'not-a-uuid'), says(/No such active key/));
    assert.ok(await findProject(db, key), 'still active');
  });
});

describe('members', () => {
  beforeEach(() => (lookups = []));

  it('adds a GitHub user by username, who gets access on signing in', async () => {
    await addMember(db, owner, project, '@cy', 'member', fakeLookup);
    const cy = await signedIn(db, 'cy', '303');
    assert.equal(await requireMember(db, cy, project), 'member');
    assert.deepEqual(
      (await listMembers(db, owner, project)).map((m) => [m.githubLogin, m.role]),
      [
        ['ada', 'owner'],
        ['bob', 'member'],
        ['cy', 'member'],
      ],
    );
  });

  it('stores GitHub’s spelling and id, and refuses duplicates', async () => {
    await addMember(db, owner, project, 'Dee', 'owner', fakeLookup);
    await assert.rejects(addMember(db, owner, project, 'Dee', 'member', fakeLookup), says(/already a member/));
    const dee = (await listMembers(db, owner, project)).find((m) => m.githubId === '404');
    assert.deepEqual(dee, { githubId: '404', githubLogin: 'Dee', role: 'owner' });
  });

  it('rejects malformed usernames without asking GitHub, and unknown ones after asking', async () => {
    for (const bad of ['', 'a b', '-lead', 'trail-', 'dou--ble', 'x'.repeat(40), '../users', 'ada?x=1']) {
      await assert.rejects(addMember(db, owner, project, bad, 'member', fakeLookup), says(/isn't a GitHub username/));
    }
    assert.deepEqual(lookups, []);
    await assert.rejects(addMember(db, owner, project, 'nobody', 'member', fakeLookup), says(/no GitHub user/));
    assert.deepEqual(lookups, ['nobody']);
  });

  it('removes members but always keeps an owner', async () => {
    await removeMember(db, owner, project, '202');
    await assert.rejects(requireMember(db, member, project), is(404));
    await assert.rejects(removeMember(db, owner, project, '101'), says(/needs an owner/));
    await assert.rejects(removeMember(db, owner, project, '999'), says(/No such member/));

    await addMember(db, owner, project, 'Dee', 'owner', fakeLookup);
    await removeMember(db, owner, project, '101'); // another owner exists now
    await assert.rejects(requireMember(db, owner, project), is(404));
  });

  it('githubLookup never builds a URL from a malformed username', async () => {
    assert.equal(await githubLookup('../../orgs/x'), undefined);
    assert.equal(await githubLookup('a/b'), undefined);
  });
});

describe('settings', () => {
  async function seedMessage(projectId: string) {
    await db
      .insert(messages)
      .values({ projectId, id: HASH, direction: 'in', channel: 'c', threadId: HASH, text: 'secret', at: new Date() });
  }

  it('turning message text off deletes this project’s stored texts only, and keeps traces', async () => {
    const other = await createProject(db, owner, 'ada', 'Other');
    await seedMessage(project);
    await seedMessage(other);
    await db.insert(traces).values({
      projectId: project,
      id: 't1',
      conversation: HASH,
      channel: 'c',
      threadId: HASH,
      startedAt: new Date(),
      durationMs: 1,
      sentCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      messageIds: [],
      spans: [],
    });

    await setStoreText(db, owner, project, false);
    assert.equal((await getProject(db, owner, project)).storeText, false);
    assert.deepEqual(
      (await db.select().from(messages)).map((m) => m.projectId),
      [other],
    );
    assert.equal((await db.select().from(traces)).length, 1);

    await setStoreText(db, owner, project, true);
    assert.equal((await getProject(db, owner, project)).storeText, true);
  });

  it('deletes a project only when its name is typed exactly', async () => {
    await createKey(db, owner, project);
    await assert.rejects(deleteProject(db, owner, project, 'support bot'), says(/Type the project name/));
    await deleteProject(db, owner, project, ' Support bot ');
    await assert.rejects(getProject(db, owner, project), is(404));
    assert.equal((await db.select().from(ingestKeys)).length, 0);
    assert.equal((await db.select().from(projectMembers).where(eq(projectMembers.projectId, project))).length, 0);
  });
});
