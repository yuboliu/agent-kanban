---
name: ak-verify
description: |
  Post-write verification workflow: test, review, and regression-check code
  changes before they are submitted. Use after any non-trivial code change
  (features, bug fixes, refactors touching behavior), and use it as the
  acceptance standard when reviewing changes made by others. Do not use for
  trivial changes (typo fixes, comment tweaks) or docs-only edits.
---

# ak-verify — Post-Write Verification

Run this workflow after every non-trivial code change, before the change is
submitted for review. It is also the acceptance standard a maintainer applies
when reviewing someone else's change.

## Roles

The workflow is defined in roles, not specific tooling. Map them to whatever
your runtime provides:

- **Author** — orchestrates the workflow. The only role allowed to modify
  source code.
- **Test author** — writes and updates unit/integration tests and runs them.
- **E2E author** — writes and repairs browser/E2E tests. Only involved when
  the change touches frontend/UI code.
- **Reviewer** — reviews both source and test code for correctness,
  conventions, and maintainability. Returns PASS or REVISE with concrete
  findings.

Mapping to runtimes:

- Runtimes with subagent support: delegate each role to an independent
  subagent so test writing and review are done by a fresh context that did
  not write the source.
- Single-agent runtimes: switch roles sequentially yourself. The review pass
  is never skipped — re-read the full diff with a reviewer's mindset
  (conventions, architecture fit, security, error handling, test quality)
  instead of re-asserting that what you wrote is right.

**Ownership rule**: the Author only modifies source code. Test code is owned
by the Test author / E2E author — all test modifications go through the test
role, never the Author fixing tests to match broken source.

## Step 1 — Tests

1. Test author writes or updates unit/integration tests covering the change
   and runs them.
2. If the change touches frontend/UI, the E2E author also creates or updates
   browser/E2E tests, and repairs any existing E2E tests broken by the
   change.
3. ALL PASS → proceed to Step 2.
4. FAILURES → the Author reads the failure and triages:
   - **Source bug** → fix the source code, re-run the tests.
   - **Test bug** → state why the test is wrong, then hand it to the Test
     author (unit) or E2E author (E2E) to fix. Never silence a real failure
     by weakening a test.

## Step 2 — Review

Reviewer reviews both source and test code (diff-level: conventions,
architecture fit, error handling, security, test quality).

- REVISE on source code → the Author fixes, then the review is re-run.
- REVISE on test code → findings go to the appropriate test role to fix.
- PASS → proceed to Step 3.

## Step 3 — Regression

Run the repository's full build, type check, and test suite to catch
breakage outside the changed area.

Discover the commands from the repository's own configuration
(`package.json` scripts, CI workflow files, Makefile, etc.) instead of
assuming. Example for a pnpm monorepo:

```bash
pnpm build && pnpm typecheck && npx vitest run
```

Watch for solution-style root tsconfigs (`"files": []` with only
`references`): a bare `tsc --noEmit` at the root checks nothing. Use the
repo's typecheck script that runs per project.

Any failure → fix and re-run. If the fix touches source code, go back to
Step 1.

## Project-Specific Steps

Repositories may define additional mandatory checks in their
`CLAUDE.md` / `AGENTS.md` / contributing docs (smoke tests, linters,
migration checks, seed scripts). Read those files and run every applicable
project-specific step before declaring the workflow complete.

## Maintainer Perspective

When reviewing a change made by someone else:

- Step 1 and Step 3 are your **verification evidence**: confirm the author
  actually ran tests and regression, and re-run them yourself when the risk
  justifies it. Missing or failing evidence is a reject reason.
- Step 2 **is** your review. Apply the same PASS/REVISE standard to the
  submitted diff.
- Map the outcome: all steps pass → accept/complete; any step fails or is
  unverifiable → reject with the specific failing step and evidence needed.
