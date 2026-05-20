# Feature

Used when triage agents decide whether a feature request should be accepted.

Config key: `triage.prompts.feature`

Built-in template: [`triage/feature.md`](/src/prompts/templates/triage/feature.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
