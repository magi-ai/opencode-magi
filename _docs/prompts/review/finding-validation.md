# Finding Validation

Used when reviewers vote on whether another reviewer's findings should remain posted.

Config key: `review.prompts.findingValidation`

Built-in template: [`review/finding-validation.md`](/src/prompts/templates/review/finding-validation.md)

| Placeholder                 | Meaning                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `{pr}`                      | Pull request number.                                              |
| `{owner}` / `{repo}`        | GitHub repository owner and name.                                 |
| `{worktreePath}`            | Temporary PR worktree path.                                       |
| `{baseSha}` / `{headSha}`   | Diff range for validating findings.                               |
| `{jsonEncodedWorktreePath}` | JSON-encoded worktree path for shell snippets.                    |
| `{findings}`                | JSON list of findings to vote on.                                 |
| `{reviewContext}`           | Rendered review context when no reusable reviewer session exists. |
