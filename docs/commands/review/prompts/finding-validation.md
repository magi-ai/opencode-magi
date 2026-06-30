<p align='center'>
  English | <a href='finding-validation.ja.md'>日本語</a>
</p>

# Finding Validation

[`finding-validation`](/src/prompts/review/finding-validation/task.md) validates whether review comments from reviewer agents that requested changes are valid.

The reviewer agent that authored the review comment counts as one agreeing vote. Magi majority-votes the review comment and posts accepted review comments. If all review comments are rejected, Magi treats the reviewer as having no remaining change requests and changes that verdict to approval.

## When It Runs

The review command runs this prompt after review or re-review when at least one reviewer agent requested changes.

## Customization

To customize this prompt, set `review.prompts.findingValidation` to the prompt file path.

## Placeholders

| Placeholder | Description          |
| ----------- | -------------------- |
| `{pr}`      | Pull request number. |
| `{owner}`   | Repository owner.    |
| `{repo}`    | Repository name.     |

## Tags

| Tag          | Description                                              |
| ------------ | -------------------------------------------------------- |
| `<findings>` | JSON array of findings from other reviewers to validate. |
