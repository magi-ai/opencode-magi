# Create PR

Template reference for creating an implementation PR from an accepted issue.

Config key: `triage.prompts.createPr`

Built-in template: [`triage/create-pr.md`](/src/prompts/templates/triage/create-pr.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
