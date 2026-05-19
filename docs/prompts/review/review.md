# Review

Used when a reviewer performs an initial PR review.

Config key: `review.prompts.review`

Built-in template: [`review/review.md`](/src/prompts/templates/review/review.md)

| Placeholder                 | Meaning                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `{pr}`                      | Pull request number.                                                    |
| `{owner}` / `{repo}`        | GitHub repository owner and name.                                       |
| `{worktreePath}`            | Temporary PR worktree path.                                             |
| `{baseSha}` / `{headSha}`   | Diff range for the review.                                              |
| `{jsonEncodedWorktreePath}` | JSON-encoded worktree path for shell snippets.                          |
| `{ciFailureContext}`        | Scope-in CI failure context, when present.                              |
| `{ciFailureContextBlock}`   | Full `<ci_failure_context>` block when context exists, otherwise empty. |
