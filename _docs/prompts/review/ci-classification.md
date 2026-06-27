# CI Classification

Used when failed checks need to be classified as caused by the PR (`SCOPE_IN`) or likely flaky, external, or infrastructure-related (`SCOPE_OUT`) before review.

Config key: `review.prompts.ciClassification`

Built-in template: [`review/ci-classification.md`](/src/prompts/templates/review/ci-classification.md)

| Placeholder          | Meaning                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `{pr}`               | Pull request number.                                                                                           |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                                                              |
| `{failedChecks}`     | JSON list of failed required checks with `name`, `workflow`, `state`, `link`, and structured failure evidence. |
