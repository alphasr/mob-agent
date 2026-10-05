import { projectPage } from '../../../../src/auth/request.ts';
import { sharedDb } from '../../../../src/db/connect.ts';
import { listKeys, listMembers } from '../../../../src/projects/manage.ts';
import {
  addMemberAction,
  createKeyAction,
  deleteProjectAction,
  removeMemberAction,
  revokeKeyAction,
  setStoreTextAction,
} from '../../actions.ts';
import { ActionForm, CreateKeyForm } from '../../forms.tsx';

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, project } = await projectPage(id);
  const db = sharedDb();
  const [keys, members] = await Promise.all([listKeys(db, user.id, id), listMembers(db, user.id, id)]);
  // Hiding owner controls is a convenience; every action checks the role again on the server.
  const isOwner = project.role === 'owner';

  return (
    <>
      <h2>Ingestion keys</h2>
      <p>
        Agents send traces with <code>TEXTAGENT_KEY</code>. Revoking a key stops its agents at their next send.
      </p>
      <ul>
        {keys.map((k) => (
          <li key={k.id}>
            <code>{k.prefix}…</code> created {k.createdAt.toISOString().slice(0, 10)}
            {k.revokedAt ? (
              ` · revoked ${k.revokedAt.toISOString().slice(0, 10)}`
            ) : isOwner ? (
              <ActionForm action={revokeKeyAction.bind(null, id, k.id)} submit="Revoke" confirm="Revoke this key?" />
            ) : null}
          </li>
        ))}
      </ul>
      {isOwner && <CreateKeyForm action={createKeyAction.bind(null, id)} />}

      <h2>Members</h2>
      <ul>
        {members.map((m) => (
          <li key={m.githubId}>
            {m.githubLogin} ({m.role})
            {isOwner && (
              <ActionForm
                action={removeMemberAction.bind(null, id, m.githubId)}
                submit="Remove"
                confirm={`Remove ${m.githubLogin}?`}
              />
            )}
          </li>
        ))}
      </ul>
      {isOwner && (
        <ActionForm action={addMemberAction.bind(null, id)} submit="Add">
          <input name="login" placeholder="GitHub username" required />{' '}
          <select name="role" defaultValue="member">
            <option value="member">member (can view)</option>
            <option value="owner">owner (can manage)</option>
          </select>{' '}
        </ActionForm>
      )}

      <h2>Message text</h2>
      <p>
        {project.storeText
          ? 'Message text is stored when an agent sends it (exporter option includeText).'
          : 'Message text is never stored; agents that send it have it dropped.'}
      </p>
      {isOwner &&
        (project.storeText ? (
          <ActionForm
            action={setStoreTextAction.bind(null, id, false)}
            submit="Stop storing message text"
            confirm="This also deletes every message text stored for this project. Continue?"
          />
        ) : (
          <ActionForm action={setStoreTextAction.bind(null, id, true)} submit="Store message text" />
        ))}

      {isOwner && (
        <>
          <h2>Delete project</h2>
          <ActionForm
            action={deleteProjectAction.bind(null, id)}
            submit="Delete project"
            confirm="Delete this project with all its traces, messages and keys?"
          >
            <input name="name" placeholder={`Type “${project.name}”`} required />{' '}
          </ActionForm>
        </>
      )}
    </>
  );
}
