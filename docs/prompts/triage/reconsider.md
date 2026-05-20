# Reconsider

Used when allowed mention replies trigger reconsideration of a previous Magi triage result.

Config key: `triage.prompts.reconsider`

Built-in template: [`triage/reconsider.md`](/src/prompts/templates/triage/reconsider.md)

| Placeholder          | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `{issue}`            | Issue number.                                                                  |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                              |
| `{context}`          | JSON context with previous marker, classified mention replies, and issue data. |
