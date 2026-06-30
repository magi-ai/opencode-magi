<p align='center'>
  English | <a href='close-reconsideration.ja.md'>日本語</a>
</p>

# Close Reconsideration

[`close-reconsideration`](/src/prompts/review/close-reconsideration/task.md) asks reviewer agents that chose close but ended up in the minority to reconsider their verdict.

The prompt asks the reviewer to change the rejected close verdict to approval or changes requested.

## When It Runs

The review command runs this prompt when `review.merge.approvalPolicy` is `unanimous`, one or more reviewers chose close, and close did not reach majority.

## Customization

To customize this prompt, set `review.prompts.closeReconsideration` to the prompt file path.

## Placeholders

| Placeholder | Description          |
| ----------- | -------------------- |
| `{pr}`      | Pull request number. |
| `{owner}`   | Repository owner.    |
| `{repo}`    | Repository name.     |
