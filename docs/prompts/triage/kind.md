# Kind

Used when triage agents classify an issue as a bug, feature request, or needing more information.

Config key: `triage.prompts.kind`

Built-in template: [`triage/kind.md`](/src/prompts/templates/triage/kind.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
