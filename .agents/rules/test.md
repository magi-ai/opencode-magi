# Test Rules

Use targeted automated tests to protect changed behavior. Keep tests deterministic and focused on the smallest behavior that could regress.

## Required Coverage

- Add or update unit tests when changing config validation, config resolution, majority logic, prompt composition, model output parsing, report formatting, or small pure helpers.
- Add or update integration or flow tests when changing orchestration across modules, command sequencing, retry behavior, safety gates, run state, review flow, merge flow, triage flow, or CI handling.
- Add or update scenario tests when a user-visible command or long-running workflow changes across multiple decisions, such as issue triage, PR review, merge orchestration, CI reruns, or thread resolution.
- Prefer updating an existing nearby test file before adding a new one.

## Test Placement

- Put tests next to the related source as `src/**/*.test.ts`.
- Keep fixtures small and explicit. Inline inputs are preferred unless a shared fixture materially improves readability.
- Test observable behavior, not private implementation details.

## GitHub And Model Calls

- Automated tests must not rely on live GitHub calls, live OpenCode sessions, live model responses, network state, local authentication, or repository state outside the test.
- Mock GitHub command execution by injecting fake exec functions, returning deterministic stdout or errors, and recording commands for assertions.
- Mock `gh auth token`, `gh api`, `gh pr`, `gh issue`, `gh run`, and other CLI responses instead of shelling out to the real GitHub CLI.
- Mock model responses with exact text or structured output needed by the flow. Include malformed output and repair cases when changing output parsing or retry logic.

## Verification Commands

- Run the most specific affected test file first, for example `pnpm vitest run src/config/validate.test.ts`.
- When a change spans an area, run the relevant area tests, for example `pnpm vitest run src/orchestrator/merge.test.ts src/orchestrator/ci.test.ts`.
- Run `pnpm test` when the change crosses several areas or when targeted coverage does not give enough confidence.
- Do not run format, lint, or typecheck unless explicitly requested; those are handled by lefthook and CI.
- For documentation-only changes, automated tests are not required unless the documentation change also modifies executable examples, schemas, or generated content.
