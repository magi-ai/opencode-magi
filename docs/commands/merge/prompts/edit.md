<p align='center'>
  English | <a href='edit.ja.md'>日本語</a>
</p>

# Edit

[`edit`](/src/prompts/merge/edit/task.md) asks the editor agent to handle unresolved review threads.

The prompt asks the editor agent to act as the pull request author. For each unresolved thread, it can fix the issue, disagree with the request, or ask a concrete question.

## When It Runs

The merge command runs this prompt after [review](/docs/commands/review/index.md) or [re-review](/docs/commands/review/index.md), only when there are unresolved review threads.

## Customization

To customize this prompt, set `merge.prompts.edit` to the prompt file path.

## Placeholders

| Placeholder      | Description          |
| ---------------- | -------------------- |
| `{pr}`           | Pull request number. |
| `{owner}`        | Repository owner.    |
| `{repo}`         | Repository name.     |
| `{worktreePath}` | Worktree path.       |

## Tags

| Tag                    | Description                              |
| ---------------------- | ---------------------------------------- |
| `<unresolved_threads>` | JSON array of unresolved review threads. |
