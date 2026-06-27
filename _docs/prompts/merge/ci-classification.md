# CI Classification

Used when failed checks need to be classified after the editor has pushed fixes.

Config key: `merge.prompts.ciClassification`

Built-in template: [`merge/ci-classification.md`](/src/prompts/templates/merge/ci-classification.md)

| Placeholder                       | Meaning                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `{pr}`                            | Pull request number.                                                                                           |
| `{owner}` / `{repo}`              | GitHub repository owner and name.                                                                              |
| `{cycle}`                         | Edit cycle number.                                                                                             |
| `{previousHeadSha}` / `{headSha}` | Diff range for the editor changes.                                                                             |
| `{worktreePath}`                  | Temporary PR worktree path.                                                                                    |
| `{jsonEncodedWorktreePath}`       | JSON-encoded worktree path for shell snippets.                                                                 |
| `{failedChecks}`                  | JSON list of failed required checks with `name`, `workflow`, `state`, `link`, and structured failure evidence. |
