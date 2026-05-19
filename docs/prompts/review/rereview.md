# Re-review

Used when a reviewer checks new commits or editor changes against unresolved review threads.

Config key: `review.prompts.rereview`

Built-in template: [`review/rereview.md`](/src/prompts/templates/review/rereview.md)

| Placeholder                       | Meaning                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `{pr}`                            | Pull request number.                                                                  |
| `{owner}` / `{repo}`              | GitHub repository owner and name.                                                     |
| `{worktreePath}`                  | Temporary PR worktree path.                                                           |
| `{previousHeadSha}` / `{headSha}` | Diff range for the re-review.                                                         |
| `{jsonEncodedWorktreePath}`       | JSON-encoded worktree path for shell snippets.                                        |
| `{unresolvedThreads}`             | JSON list of unresolved review threads for the reviewer.                              |
| `{ciFailureContext}`              | Scope-in CI failure context, when present.                                            |
| `{ciFailureContextBlock}`         | Full `<ci_failure_context>` block when context exists, otherwise empty.               |
| `{previousReview}`                | Previous GitHub review metadata, when available.                                      |
| `{previousReviewBlock}`           | Full `<previous_review>` block when previous review metadata exists, otherwise empty. |
