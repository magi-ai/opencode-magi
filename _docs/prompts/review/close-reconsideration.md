# Close Reconsideration

Used when a reviewer returned `CLOSE`, but `CLOSE` did not reach majority. The reviewer must choose `MERGE` or `CHANGES_REQUESTED` before anything is posted.

This same config key is used for both initial review close reconsideration and re-review close reconsideration. The built-in task template is shared, but Magi still appends the phase-specific fixed output contract.

Config key: `review.prompts.closeReconsideration`

Built-in template: [`review/close-reconsideration.md`](/src/prompts/templates/review/close-reconsideration.md)

| Placeholder                       | Meaning                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| `{pr}`                            | Pull request number.                                              |
| `{owner}` / `{repo}`              | GitHub repository owner and name.                                 |
| `{worktreePath}`                  | Temporary PR worktree path.                                       |
| `{baseSha}` / `{headSha}`         | Diff range for initial review reconsideration.                    |
| `{previousHeadSha}` / `{headSha}` | Diff range for re-review reconsideration.                         |
| `{jsonEncodedWorktreePath}`       | JSON-encoded worktree path for shell snippets.                    |
| `{closeReason}`                   | The original minority close reason.                               |
| `{reviewContext}`                 | Rendered review context when no reusable reviewer session exists. |
