<p align='center'>
  English | <a href='ci-classification.ja.md'>日本語</a>
</p>

# CI Classification

[`ci-classification`](/src/prompts/merge/ci-classification/task.md) classifies failed required CI checks after editor changes.

The prompt asks each reviewer agent to decide whether every failed check is caused by the pull request changes, the editor changes, or is likely flaky, external, or infrastructure-related. Classifications are majority-voted per check.

Failures that appeared after editor changes are treated as in scope unless there is strong evidence they are unrelated.

## When It Runs

The merge command runs this prompt after the editor changes the pull request, required check results are fetched, and at least one required check failed.

## Customization

To customize this prompt, set `merge.prompts.ciClassification` to the prompt file path.

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

| Tag               | Description                           |
| ----------------- | ------------------------------------- |
| `<failed_checks>` | JSON array of failed required checks. |
