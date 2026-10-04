## Prompt sequence (how every task runs)

Every non-trivial task moves through these steps in order. Don't skip ahead: no code before step 4.
For a trivial change (typo, one-line fix), use judgment and compress steps 1–3 into a sentence.

1. **Frame.** Restate the context, language/runtime, constraints and what will be handed back.
   If any of these is missing from the request, ask before going further.
2. **Clarify.** Before any code, list the edge cases and ambiguities you see, each with a proposed
   default. Let the user confirm or change them; "defaults OK" is a valid answer.
3. **Plan.** Offer 2–3 approaches with their tradeoffs and recommend one, saying why.
   The user picks. Record the decision in `plan.md`.
4. **Build in pieces.** One function, component or module per step. Finish it, test it and report
   it before starting the next. Name the next piece and wait for the go-ahead.
5. **Verify.** Every piece ships with tests. Trace at least one tricky input through the code, say
   which weak spots remain, and state plainly what is untested (e.g. needs a real device or credentials).
6. **Refine.** When something breaks, start from the exact error and the specific line. Fix the
   root cause with a focused change; don't rewrite around it.

When reporting, say which step you're on and what comes next.
