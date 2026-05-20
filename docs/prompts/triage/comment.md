# Comment

Template reference for composing a final triage comment.

Config key: `triage.prompts.comment`

Built-in template: [`triage/comment.md`](/src/prompts/templates/triage/comment.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
