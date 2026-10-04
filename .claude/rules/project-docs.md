## Project docs: CLAUDE.md and plan.md (ALWAYS KEEP CURRENT)

`CLAUDE.md` (how the project is built and run today) and `plan.md` (roadmap, status, open decisions) at the repo root are the central project documentation. They must never drift from the code.

### Before starting work

- Read `plan.md` to see what's done, what's next, and which decisions are still open. If the task conflicts with the plan or depends on an open decision, say so before starting.

### In the same change as the work - not later

Update **`CLAUDE.md`** when a change affects any of:

- Repository layout (new app, package, top-level folder, or a notable new module)
- Commands or scripts (added, renamed, removed, or changed behavior)
- Environment variables (new, removed, or changed defaults/requirements)
- An architecture decision (data store, auth model, scoping, contracts, error handling, styling approach)
- A local-development gotcha someone else would hit

Update **`plan.md`** when:

- A roadmap item is started (🚧) or finished (✅) - move it to "Done" when complete
- New work, a known gap, or tech debt is discovered - add it to the right section
- An open decision is made (move it out of "Open decisions" and record the outcome) or a new one arises
- Something is evaluated and rejected - record it under "Decided against" with the date
- Always bump the `_Last updated_` date

### Rules

- Describe what **is**, not what was planned - verify paths, commands, and variables against the code before writing them.
- Keep both files concise; `CLAUDE.md` is loaded into every session. Link to code instead of duplicating it, and never restate `.claude/rules/`.
- Never put secrets, credentials, or connection strings with passwords in either file.
- A task is not complete until both files reflect it. When reporting completion, state which of the two you updated (or why neither needed changes).
