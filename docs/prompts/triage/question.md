# Question

Template reference for composing follow-up questions for an issue.

Config key: `triage.prompts.question`

Built-in template: [`triage/question.md`](/src/prompts/templates/triage/question.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
