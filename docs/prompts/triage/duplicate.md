# Duplicate

Used when triage voters decide whether an issue duplicates one of the provided duplicate candidates.

Config key: `triage.prompts.duplicate`

Built-in template: [`triage/duplicate.md`](/src/prompts/templates/triage/duplicate.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
