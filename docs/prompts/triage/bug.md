# Bug

Used when triage agents decide whether a bug report is valid and should be accepted.

Config key: `triage.prompts.bug`

Built-in template: [`triage/bug.md`](/src/prompts/templates/triage/bug.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
