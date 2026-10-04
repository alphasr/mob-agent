## CORE PRIORITIES (IN ORDER)

1. **Correctness**
2. **Clarity**
3. **Long-term maintainability**
4. **Consistency with existing patterns**

Speed, cleverness, or novelty must _never_ override these priorities.

---

## PROJECT SHAPE (proposed - adjust once scaffolded)

ai-rent is an AI-native short-term-rental property management system: an event-driven backend running scoped agents (guest messaging, pricing, turnover/cleaning dispatch, maintenance triage, owner reporting) behind a guardrail/policy layer, plus a dashboard for operators (approval queue) and owners (reporting).

Proposed structure, TypeScript throughout:

- `apps/web` - Next.js. Operator approval queue, owner dashboard/reporting. Client components for anything per-user/authenticated (mirrors the same reasoning as before: auth-gated data can't be safely server-rendered without re-deriving the session).
- `apps/api` - Express. Webhook ingestion (PMS/channel manager events), the event router, agent invocations, tool layer, guardrail checks.
- Shared types between `apps/web` and `apps/api` belong in a shared package once both exist - don't duplicate event/tool schemas.

Until this structure exists, treat this section as the target, not a fact - confirm actual paths before assuming them.

---

## CHANGE DISCIPLINE

- Every change must:
  - Address the **actual root cause**, not symptoms
  - Have a **clear, defensible rationale**
- Avoid:
  - One-off logic, hacks, or workarounds that bypass established systems
  - Partial fixes that shift the problem elsewhere
- If a solution feels ad-hoc, **stop and redesign**.
- When fixing a bug, verify the fix doesn't introduce regressions in related paths.

---

## CONSISTENCY & REUSE (STRICT)

Before writing any new code:

1. Search the codebase for existing implementations
2. Check `apps/web/components/`, `apps/web/lib/`, and `apps/api/src/` for reusable logic once they exist
3. Check existing patterns for event handling, tool schemas, and guardrail checks before inventing new ones

Rules:

- **Never reimplement existing logic.** Prefer extension or reuse over duplication.
- If a pattern exists, **follow it** - even if another approach seems simpler.
- If you believe an existing pattern is wrong, flag it. Do not silently deviate.
- Agent tool schemas, event schemas, and guardrail checks are shared contracts - changing one without checking every caller is a correctness bug, not a style issue.

---

## NAMING CONVENTIONS

**Files & Folders**

- React components: `PascalCase.tsx` - e.g. `ApprovalQueueRow.tsx`
- Hooks: `camelCase.ts` prefixed with `use` - e.g. `usePendingActions.ts`
- Utilities/helpers: `camelCase.ts` - e.g. `formatCurrency.ts`
- Constants: `SCREAMING_SNAKE_CASE` inside `camelCase.ts` files
- Next.js routes follow App Router conventions: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`
- Agents: `camelCase.ts` named for the workflow - e.g. `guestMessagingAgent.ts`, `maintenanceTriageAgent.ts`

**Variables & Functions**

- Boolean variables: prefix with `is`, `has`, `can`, `should` - e.g. `isAutoExecutable`, `hasPendingApproval`
- Event handlers: prefix with `handle` - e.g. `handleApprove`, `handleReject`
- Async functions: use verb phrases - e.g. `dispatchCleaner`, `classifyUrgency`
- Avoid abbreviations unless universally understood (`id`, `url`, `api`)

**Types & Interfaces**

- Use `PascalCase`: `PropertyContext`, `AgentAction`, `GuardrailDecision`
- Prefer `interface` for object shapes, `type` for unions/intersections
- No `I` prefix on interfaces

---

## TYPESCRIPT

- **No `any`**. Use `unknown` and narrow it, or define a proper type.
- Avoid type assertions (`as X`) unless there is no alternative - comment why when used.
- Prefer explicit return types on exported functions and hooks.
- Use generics to avoid duplication across similar types (e.g. a generic `AgentResult<TAction>`).
- Colocate types with the code that owns them. Shared frontend types go in `apps/web/lib/types.ts`, shared backend types (event schemas, tool contracts, guardrail decisions) in `apps/api/src/types/`.

---

## REACT & NEXT.JS CONVENTIONS

**Components**

- One component per file.
- Keep components focused - if it needs a long comment to explain what it does, split it.
- Prefer Server Components by default in the App Router. Use `'use client'` only when required (event handlers, hooks, browser APIs).
- Do not add `'use client'` to layouts or pages unless necessary - push it down to the smallest possible subtree.

**Props**

- Define props as a named `interface` directly above the component.
- Destructure props in the function signature.
- Avoid passing raw objects when a specific shape suffices.

**Hooks**

- Extract stateful logic into custom hooks when it spans more than one component.
- Hooks must be pure with respect to their declared dependencies.
- Do not call hooks conditionally.

**Data Fetching**

- All API calls to the Express backend go through a single client module (e.g. `apps/web/lib/api.ts`) - never call `fetch` directly against `/api/*` from a component.
- The operator approval queue and owner dashboard are per-user, authenticated views - fetch client-side (`"use client"` + `useEffect`/a query library) rather than server-side, same reasoning as any auth-gated page: server rendering can't safely re-derive the session.
- Any public marketing/landing routes should stay server components - no client-side fetching there.

---

## IMPORT ORDERING

Enforce this order (separated by blank lines):

```
1. React / Next.js core imports
2. Third-party libraries
3. Internal aliases (@/components, @/lib, @/hooks, @/types)
4. Relative imports
5. Style imports (CSS modules, etc.)
```

---

## COMMENTS & CODE STYLE

- Prefer **self-explanatory code** over comments.
- Do **not** add comments that restate what the code already expresses.
- Add comments **only** when:
  - Intent is non-obvious
  - There are important constraints or edge cases (e.g. why a guardrail threshold is set where it is)
  - A workaround exists for an external limitation (link to issue/PR)

---

## SHARED COMPONENTS & BACKWARD COMPATIBILITY

- Shared components (`src/components/`) and shared contracts (event schemas, tool schemas, guardrail decision shapes) may be used across many contexts.
- You must:
  - Preserve backward compatibility - do not change existing prop signatures or schema fields without instruction
  - Avoid breaking implicit contracts (default behavior, DOM structure, or downstream agent expectations consumers may depend on)
- If a breaking change is needed, flag it explicitly before proceeding.
- Extend via new optional props/fields, not by modifying existing ones.

---

## IMPLEMENTATION SCOPE CONTROL

- Do not over-engineer. Do not introduce abstractions before they are needed twice.
- Each change should be: small, focused, and fully sufficient to solve the problem.
- Always consider **downstream impact** - who else calls this function, renders this component, subscribes to this event, or depends on this type.
- If a change grows beyond its original scope, stop and discuss before continuing.
