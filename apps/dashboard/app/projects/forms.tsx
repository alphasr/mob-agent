'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';
import type { ActionState } from './actions.ts';

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

/** A form for one server action, showing its error (if any) next to the button. */
export function ActionForm({
  action,
  submit,
  confirm,
  children,
}: {
  action: Action;
  submit: string;
  /** Asked before submitting, for actions that delete things. */
  confirm?: string;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {children}
      <button type="submit" disabled={pending}>
        {submit}
      </button>
      {state?.error && <span role="alert"> {state.error}</span>}
    </form>
  );
}

/** Creates a key and shows it this one time. */
export function CreateKeyForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction}>
      <button type="submit" disabled={pending}>
        Create key
      </button>
      {state?.error && <span role="alert"> {state.error}</span>}
      {state?.key && (
        <p>
          Copy it now; it won't be shown again:
          <br />
          <code>TEXTAGENT_KEY={state.key}</code>
        </p>
      )}
    </form>
  );
}
