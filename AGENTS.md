# opencode-magi Development Guide

opencode-magi is an OpenCode plugin for multi-agent GitHub pull request review and merge orchestration.

## Critical Rules

- **Do not bundle multiple fixes**: If you encounter a separate issue while working on a fix, do not fix it in the same PR. Create a separate issue and submit a separate PR.
- **Do not run format, lint, or typecheck unless explicitly asked**: Format, lint and typecheck are handled by lefthook on commit. However, run tests for the changed files locally to verify that the implementation works correctly.

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

## Testing

- Read [Test Rules](.agents/rules/test.md) before adding or changing tests.
- Add or update unit tests for config validation, majority logic, prompt composition, and output parsing when changing those areas.
- Do not rely on live GitHub calls in unit tests; mock command execution instead.
