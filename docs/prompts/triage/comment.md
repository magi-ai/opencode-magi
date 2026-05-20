# Comment

Used when Magi composes a final visible issue comment for non-`ASK` triage results.

Config key: `triage.prompts.comment`

Built-in template: [`triage/comment.md`](/src/prompts/templates/triage/comment.md)

| Placeholder          | Meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                              |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                          |
| `{author}`           | Issue author login that must be mentioned.                                 |
| `{context}`          | JSON context with issue metadata, decision, action, and relationship data. |
