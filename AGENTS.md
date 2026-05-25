# opencode-magi Development Guide

opencode-magi is an OpenCode plugin for multi-agent GitHub pull request review and merge orchestration.

## Critical Rules

### Do Not Bundle Multiple Fixes

**Keep each PR focused on one fix.**

If you encounter a separate issue while working on a fix, do not fix it in the same PR. Create a separate issue and submit a separate PR.

### Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Rules

When performing one of the actions below, read the linked rule first.

- Creating branches:
  - [Branch Rules](.agents/rules/branch.md)
- Creating commits:
  - [Commit Rules](.agents/rules/commit.md)
  - [Pre-commit Hooks](.agents/references/pre-commit-hooks.md)
- Creating issues:
  - [Issue Rules](.agents/rules/issue.md)
- Creating PRs:
  - [PR Rules](.agents/rules/pr.md)
- Reviewing PRs:
  - [PR Merge Guidelines](.agents/references/pr-merge-guidelines.md)
  - [PR Review Guidelines](.agents/references/pr-review-guidelines.md)
- Adding or changing tests:
  - [Test Rules](.agents/rules/test.md)

When editing or reviewing files that match a pattern below, read the linked rule first.

- [Skills](.agents/rules/skills.md):
  - `.agents/skills/**/*.md`
- [Changesets](.agents/rules/changesets.md):
  - `src/**/*.{ts,md,json}`
  - `!src/**/*.test.ts`
  - `.changeset/*.md`
  - `schema.json`
  - `package.json`
  - `README.md`
- [Source](.agents/rules/source.md):
  - `src/**/*.{ts,md,json}`
  - `!src/**/*.test.ts`
- [Documentation](.agents/rules/documentation.md):
  - `{.agents,docs}/**/*.md`
  - `./*.md`

## Development Commands

```bash
pnpm install
pnpm quality
pnpm build
```

Use targeted commands when iterating:

```bash
pnpm format:check
pnpm lint:check
pnpm typecheck
pnpm test
```

## Tooling

- TypeScript is checked and built with `tsgo`.
- Formatting is handled by `oxfmt`.
- Linting is handled by `oxlint`.
- Git hooks are managed by `lefthook`.
- Commit messages are checked with `commitlint`.
- Releases are managed by Changesets and the GitHub Release workflow.
