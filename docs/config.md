# Config

Magi uses its own config files instead of storing custom keys in OpenCode's `opencode.json`.

Config files are merged by OpenCode Magi, not by OpenCode. Priority, lowest to highest:

1. `~/.config/opencode/magi.json` - global defaults.
2. `<project>/.opencode/magi.json` - project overrides.

Object values are deep merged. Array values are replaced, so setting `review.agents` in the project config replaces the global reviewer list.

## Validate

Run `/magi:validate` to check Magi config presence and content.

Validation reports whether these files are found, missing, or invalid:

- `~/.config/opencode/magi.json`
- `<project>/.opencode/magi.json`

If at least one config exists, Magi validates the merged effective config and reports invalid keys in the output.

## Global Example

```json
{
  "$schema": "https://raw.githubusercontent.com/magi-ai/opencode-magi/main/schema.json",
  "review": {
    "agents": [
      {
        "id": "general",
        "model": "openai/gpt-5.5",
        "account": "your-account-1"
      },
      {
        "id": "security",
        "model": "anthropic/claude-opus-4-7",
        "account": "your-account-2",
        "persona": "Focus on security vulnerabilities."
      },
      {
        "id": "compat",
        "model": "opencode/kimi-k2-6",
        "options": { "reasoningEffort": "high" },
        "account": "your-account-3",
        "persona": "Focus on backward compatibility."
      }
    ]
  }
}
```

## Project Example

```json
{
  "$schema": "https://raw.githubusercontent.com/magi-ai/opencode-magi/main/schema.json",
  "github": {
    "host": "github.com",
    "owner": "yamada-ui",
    "repo": "yamada-ui"
  },
  "language": "ja",
  "review": {
    "merge": {
      "queue": true
    },
    "prompts": {
      "reviewGuidelines": ".agents/references/review-guidelines.md"
    }
  },
  "merge": {
    "editor": {
      "model": "openai/gpt-5.5",
      "account": "your-editor-account",
      "author": {
        "name": "your-account",
        "email": "your-email@example.com"
      }
    },
    "prompts": {
      "editGuidelines": ".agents/references/edit-guidelines.md"
    }
  }
}
```

## Reference

| Key                                   | Scope   | Required            | Default                                             | Description                                                                                                          |
| ------------------------------------- | ------- | ------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `github`                              | Project | Yes                 | -                                                   | GitHub repository target.                                                                                            |
| `github.host`                         | Project | No                  | `github.com`                                        | GitHub host.                                                                                                         |
| `github.owner`                        | Project | Yes                 | -                                                   | GitHub repository owner.                                                                                             |
| `github.repo`                         | Project | Yes                 | -                                                   | GitHub repository name.                                                                                              |
| `github.apiRetryAttempts`             | Project | No                  | `3`                                                 | Number of retry attempts for GitHub CLI API calls that fail with rate limit errors.                                  |
| `language`                            | Both    | No                  | -                                                   | Default language hint for generated reviews and comments.                                                            |
| `agents.permissions`                  | Both    | No                  | [json](/src/permissions/common.json)                | Common OpenCode permission rules applied before per-agent `permissions`.                                             |
| `output.repairAttempts`               | Both    | No                  | `3`                                                 | Number of times to ask a model to repair invalid structured output.                                                  |
| `review`                              | Both    | Yes                 | -                                                   | PR review configuration used by `/magi:review` and the review phase of `/magi:merge`.                                |
| `review.agents`                       | Both    | Yes                 | -                                                   | Odd-length array of at least 3 reviewer agents.                                                                      |
| `review.agents[].id`                  | Both    | No                  | `reviewer-1`, ...                                   | Reviewer key used for run state, output files, and session tracking.                                                 |
| `review.agents[].model`               | Both    | Yes                 | -                                                   | Full OpenCode model ID used by the reviewer.                                                                         |
| `review.agents[].account`             | Both    | Yes                 | -                                                   | GitHub account used to post reviews and approvals.                                                                   |
| `review.agents[].options`             | Both    | No                  | -                                                   | OpenCode provider/model options injected for this reviewer.                                                          |
| `review.agents[].permissions`         | Both    | No                  | -                                                   | OpenCode permission overrides for this reviewer and this reviewer's CI classifier sessions.                          |
| `review.agents[].persona`             | Both    | No                  | -                                                   | Reviewer-specific additional perspective.                                                                            |
| `review.prompts.review`               | Both    | No                  | [md](/docs/prompts/review/review.md)                | Task template override for initial review.                                                                           |
| `review.prompts.rereview`             | Both    | No                  | [md](/docs/prompts/review/rereview.md)              | Task template override for re-review after edits.                                                                    |
| `review.prompts.reviewGuidelines`     | Both    | No                  | -                                                   | Markdown file appended to reviewer prompts as shared review guidance.                                                |
| `review.prompts.ciClassification`     | Both    | No                  | [md](/docs/prompts/review/ci-classification.md)     | Task template override for classifying failed checks before review.                                                  |
| `review.prompts.findingValidation`    | Both    | No                  | [md](/docs/prompts/review/finding-validation.md)    | Task template override for voting on review findings.                                                                |
| `review.prompts.closeReconsideration` | Both    | No                  | [md](/docs/prompts/review/close-reconsideration.md) | Task template override when a close verdict is in the minority. Used for review and re-review.                       |
| `review.checks.exclude`               | Both    | No                  | `[]`                                                | Check names to exclude from failure classification. Exact strings and `/regex/` patterns supported.                  |
| `review.checks.wait`                  | Both    | No                  | `true`                                              | Whether to wait for PR checks before review.                                                                         |
| `review.checks.retryFailedJobs`       | Both    | No                  | `3`                                                 | Number of times to rerun failed GitHub Actions jobs classified as scope-outside.                                     |
| `review.safety.requiredLabels`        | Both    | No                  | `[]`                                                | Labels that must all be present on the PR.                                                                           |
| `review.safety.blockedPaths`          | Both    | No                  | `[]`                                                | Glob patterns for changed files that block Magi automation.                                                          |
| `review.safety.maxChangedFiles`       | Both    | No                  | -                                                   | Maximum changed file count allowed before Magi blocks the run.                                                       |
| `review.safety.allowAuthors`          | Both    | No                  | `[]`                                                | If set, only these PR authors are allowed to run through Magi.                                                       |
| `review.automation.merge`             | Both    | No                  | `false`                                             | Whether `/magi:review` runs `gh pr merge` after reviewer majority approves.                                          |
| `review.automation.close`             | Both    | No                  | `false`                                             | Whether `/magi:review` runs `gh pr close` after a close majority.                                                    |
| `review.concurrency.runs`             | Both    | No                  | `3`                                                 | Maximum PR runs processed at the same time.                                                                          |
| `review.concurrency.reviewers`        | Both    | No                  | `3`                                                 | Maximum reviewer agents running at once per PR phase.                                                                |
| `review.merge.method`                 | Both    | No                  | `squash`                                            | Merge method: `merge`, `squash`, or `rebase`.                                                                        |
| `review.merge.auto`                   | Both    | No                  | `true`                                              | Whether Magi passes `--auto` to `gh pr merge`.                                                                       |
| `review.merge.deleteBranch`           | Both    | No                  | `true`                                              | Whether Magi passes `--delete-branch` to `gh pr merge`.                                                              |
| `review.merge.queue`                  | Both    | No                  | `false`                                             | Whether Magi polls merge queue completion after `gh pr merge`.                                                       |
| `review.merge.approvalPolicy`         | Both    | No                  | `majority`                                          | `majority` merges on reviewer majority; `unanimous` requires all reviewers to approve.                               |
| `review.output`                       | Both    | No                  | `.magi/runs/pr`                                     | Directory for PR run artifacts. PR #123 is stored under `<dir>/123/<runId>`.                                         |
| `review.worktree`                     | Both    | No                  | `.magi/worktrees/pr`                                | Directory for temporary PR worktrees. PR #123 is stored under `<dir>/pr-123`.                                        |
| `merge`                               | Both    | No                  | -                                                   | Additional `/magi:merge` configuration.                                                                              |
| `merge.editor`                        | Both    | Yes (`/magi:merge`) | -                                                   | Editor agent used by `/magi:merge`.                                                                                  |
| `merge.editor.model`                  | Both    | Yes (`/magi:merge`) | -                                                   | Full OpenCode model ID used by the editor.                                                                           |
| `merge.editor.account`                | Both    | Yes (`/magi:merge`) | -                                                   | GitHub account used for editor commits, replies, pushes, and merge operations.                                       |
| `merge.editor.author.name`            | Both    | Yes (`/magi:merge`) | -                                                   | Git commit author name configured in the temporary worktree before editor commits.                                   |
| `merge.editor.author.email`           | Both    | Yes (`/magi:merge`) | -                                                   | Git commit author email configured in the temporary worktree before editor commits.                                  |
| `merge.editor.options`                | Both    | No                  | -                                                   | OpenCode provider/model options injected for the editor.                                                             |
| `merge.editor.permissions`            | Both    | No                  | [json](/src/permissions/editor.json)                | OpenCode permission overrides for the editor.                                                                        |
| `merge.editor.persona`                | Both    | No                  | -                                                   | Editor-specific additional instructions.                                                                             |
| `merge.checks.wait`                   | Both    | No                  | `true`                                              | Whether to wait for PR checks after the editor pushes a fix commit.                                                  |
| `merge.prompts.edit`                  | Both    | No                  | [md](/docs/prompts/merge/edit.md)                   | Task template override for editor fixes, disagreements, and clarification questions.                                 |
| `merge.prompts.editGuidelines`        | Both    | No                  | -                                                   | Markdown file appended to editor prompts as shared edit guidance.                                                    |
| `merge.prompts.ciClassification`      | Both    | No                  | [md](/docs/prompts/merge/ci-classification.md)      | Task template override for classifying failed checks after editor changes.                                           |
| `merge.automation.merge`              | Both    | No                  | `true`                                              | Whether `/magi:merge` runs `gh pr merge` after reviewers approve.                                                    |
| `merge.automation.close`              | Both    | No                  | `false`                                             | Whether `/magi:merge` runs `gh pr close` after a close decision.                                                     |
| `merge.maxThreadResolutionCycles`     | Both    | No                  | `5`                                                 | Maximum fix/reply attempts per unresolved review thread before stopping that thread. Set `0` for unlimited attempts. |
| `clear.output`                        | Both    | No                  | `true`                                              | Delete inactive run output directories.                                                                              |
| `clear.worktree`                      | Both    | No                  | `true`                                              | Remove inactive run worktrees and prune worktree folders.                                                            |
| `clear.session`                       | Both    | No                  | `true`                                              | Delete OpenCode child sessions created for inactive Magi runs.                                                       |
| `clear.branch`                        | Both    | No                  | `true`                                              | Delete the branch recorded when Magi created the worktree.                                                           |

## Agent Permissions

Magi passes resolved OpenCode permission rules to every child session. `agents.permissions` is the common base for all Magi agents, and `review.agents[].permissions` or `merge.editor.permissions` override that base for one agent.

Permission values follow OpenCode's permission shape:

```json
{
  "agents": {
    "permissions": {
      "read": "allow",
      "edit": "deny",
      "bash": {
        "*": "deny",
        "git status*": "allow",
        "git diff*": "allow"
      }
    }
  },
  "review": {
    "agents": [
      {
        "id": "security",
        "model": "anthropic/claude-opus-4-7",
        "account": "your-account-2",
        "permissions": {
          "webfetch": "allow"
        }
      }
    ]
  }
}
```

Supported actions are `allow`, `ask`, and `deny`. Pattern objects are order-sensitive in OpenCode; broader rules should come first and narrower overrides later.

## Validation Rules

- Reviewers must be an odd number of at least 3.
- Reviewer keys must be unique. The key is `id` when provided, otherwise `reviewer-1`, `reviewer-2`, and so on.
- Reviewer `account` values must be unique.
- Each configured account must be logged in for GitHub CLI: `gh auth token --user <account>`.
- `merge.editor` is required when running `/magi:merge`, but not when running only `/magi:review`.
- Permission values must be `allow`, `ask`, `deny`, or an object of pattern-to-action rules.

## GitHub Permissions

Each reviewer account must be able to read the target repository and post PR reviews or comments. Each editor account must be able to reply to comments, resolve review threads, push to the PR branch, and merge or close the PR when `/magi:merge` reaches that step.

When auth validation runs, Magi checks repository-level permissions through GitHub's repository API:

- Reviewer accounts must have `.permissions.pull`.
- Editor accounts must have `.permissions.push`.

This is an early sanity check, not a complete guarantee. Branch protection, merge queue rules, fork PR branch permissions, review dismissal policies, and other repository rules can still reject pushes, merges, review posts, or thread resolution at runtime.
