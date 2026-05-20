# Action

Template reference for deciding the next action from a triage result.

Config key: `triage.prompts.action`

Built-in template: [`triage/action.md`](/src/prompts/templates/triage/action.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
