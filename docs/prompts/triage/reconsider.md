# Reconsider

Template reference for reconsidering a previous triage result after triggering comments.

Config key: `triage.prompts.reconsider`

Built-in template: [`triage/reconsider.md`](/src/prompts/templates/triage/reconsider.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
