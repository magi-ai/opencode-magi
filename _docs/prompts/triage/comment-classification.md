# Comment Classification

Used when Magi classifies mention replies for triage reconsideration.

Config key: `triage.prompts.commentClassification`

Built-in template: [`triage/comment-classification.md`](/src/prompts/templates/triage/comment-classification.md)

| Placeholder          | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `{issue}`            | Issue number.                                                                   |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                               |
| `{context}`          | JSON context with issue metadata, related PRs, candidates, and recent comments. |
