<p align='center'>
  English | <a href='review.ja.md'>日本語</a>
</p>

# Review

[`review`](/src/prompts/review/review/task.md) is the initial review prompt used by reviewer agents.

The prompt asks a reviewer agent to review only the pull request diff, evaluate related issue requirements, and make a verdict.

## When It Runs

After [CI classification](ci-classification.md), reviewer agents that have not reviewed the pull request run this prompt.

## Customization

To customize this prompt, set `review.prompts.review` to the prompt file path.

## Placeholders

| Placeholder      | Description          |
| ---------------- | -------------------- |
| `{pr}`           | Pull request number. |
| `{owner}`        | Repository owner.    |
| `{repo}`         | Repository name.     |
| `{worktreePath}` | Worktree path.       |
| `{baseSha}`      | Base commit.         |
| `{headSha}`      | Head commit.         |

## Tags

| Tag            | Description                                    |
| -------------- | ---------------------------------------------- |
| `<review>`     | JSON review context for the pull request.      |
| `<ci_failure>` | JSON array of in-scope failed required checks. |
| `<persona>`    | Reviewer persona text, when configured.        |
