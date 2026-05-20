# Category

Used when triage agents choose one configured issue category or ask for more information.

Config key: `triage.prompts.category`

Built-in template: [`triage/category.md`](/src/prompts/templates/triage/category.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{categoryOptions}`  | Configured category IDs and descriptions.                                       |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
