# Question

Used when Magi composes concrete author questions for an `ASK` triage result.

Config key: `triage.prompts.question`

Built-in template: [`triage/question.md`](/src/prompts/templates/triage/question.md)

| Placeholder          | Meaning                                                 |
| -------------------- | ------------------------------------------------------- |
| `{issue}`            | Issue number.                                           |
| `{owner}` / `{repo}` | GitHub repository owner and name.                       |
| `{author}`           | Issue author login that must be mentioned.              |
| `{context}`          | JSON context with missing information and vote context. |
