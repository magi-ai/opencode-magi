# Review

Used when a reviewer performs an initial PR review.

Config key: `review.prompts.review`

Built-in template: [`review/review.md`](/src/prompts/templates/review/review.md)

Review findings must always include `path` and `line`, and `line` must target a valid right-side PR diff line. When a concern does not map exactly to one changed line, the reviewer anchors it to the nearest changed line representing the cause, responsibility, missing implementation, or affected behavior. If `<merge_conflict_context>` is present, reviewers treat unresolved merge conflicts as findings and request changes when the PR is unsafe or impossible to merge.

| Placeholder                   | Meaning                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| `{pr}`                        | Pull request number.                                                        |
| `{owner}` / `{repo}`          | GitHub repository owner and name.                                           |
| `{worktreePath}`              | Temporary PR worktree path.                                                 |
| `{baseSha}` / `{headSha}`     | Diff range for the review.                                                  |
| `{jsonEncodedWorktreePath}`   | JSON-encoded worktree path for shell snippets.                              |
| `{ciFailureContext}`          | Scope-in CI failure context, when present.                                  |
| `{ciFailureContextBlock}`     | Full `<ci_failure_context>` block when context exists, otherwise empty.     |
| `{mergeConflictContext}`      | Merge conflict context for the PR, when conflicts exist.                    |
| `{mergeConflictContextBlock}` | Full `<merge_conflict_context>` block when context exists, otherwise empty. |
| `{reviewContext}`             | Rendered PR, related issue, PR comment, and review discussion context.      |
