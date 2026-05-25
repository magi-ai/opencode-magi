# Acceptance

Used when triage voters decide whether the selected issue category should be accepted.

Config key: `triage.prompts.acceptance`

Built-in template: [`triage/acceptance.md`](/src/prompts/templates/triage/acceptance.md)

| Placeholder          | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                               |
| `{context}`          | JSON context with selected category metadata and issue context. |
