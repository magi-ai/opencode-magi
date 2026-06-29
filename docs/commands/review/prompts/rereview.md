<p align='center'>
  English | <a href='rereview.ja.md'>日本語</a>
</p>

# Re-review

[`rereview`](/src/prompts/review/rereview/task.md) is the prompt used by reviewer agents for re-review.

The prompt asks the reviewer agent to review only the diff from the previous review HEAD commit to the current HEAD commit, check whether unresolved comments were fixed in the new diff and review thread conversation, and resolve fixed threads, reply to unresolved threads, or post separate new review comments.

## When It Runs

After [CI classification](ci-classification.md), reviewer agents with an older review run this prompt.

## Customization

To customize this prompt, set `review.prompts.rereview` to the prompt file path.

## Placeholders

| Placeholder         | Description             |
| ------------------- | ----------------------- |
| `{pr}`              | Pull request number.    |
| `{owner}`           | Repository owner.       |
| `{repo}`            | Repository name.        |
| `{worktreePath}`    | Worktree path.          |
| `{baseSha}`         | Base commit.            |
| `{previousHeadSha}` | Previous review commit. |
| `{headSha}`         | Current head commit.    |

## Tags

| Tag                    | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `<review>`             | JSON review context for the pull request.       |
| `<previous_review>`    | JSON metadata and body for the previous review. |
| `<unresolved_threads>` | JSON array of unresolved review threads.        |
| `<ci_failure>`         | JSON array of in-scope failed required checks.  |
| `<persona>`            | Reviewer persona text, when configured.         |
