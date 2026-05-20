# Action

Used when Magi records the deterministic action plan for a triage result.

Config key: `triage.prompts.action`

Built-in template: [`triage/action.md`](/src/prompts/templates/triage/action.md)

| Placeholder          | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                 |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                             |
| `{context}`          | JSON context with the triage result, allowed actions, and deterministic plan. |
