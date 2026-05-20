# Existing PR

Used when triage agents decide whether a related PR already handles an issue.

Config key: `triage.prompts.existingPr`

Built-in template: [`triage/existing-pr.md`](/src/prompts/templates/triage/existing-pr.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
