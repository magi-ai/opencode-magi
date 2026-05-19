# Config

Magi uses its own config files instead of storing custom keys in OpenCode's `opencode.json`.

Config files are merged by OpenCode Magi, not by OpenCode. Priority, lowest to highest:

1. `~/.config/opencode/magi.json` - global defaults.
2. `<project>/.opencode/magi.json` - project overrides.

Object values are deep merged. Array values are replaced, so setting `agents.reviewers` in the project config replaces the global reviewer list.

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
  "agents": {
    "reviewers": [
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
    ],
    "editor": {
      "model": "openai/gpt-5.5",
      "account": "your-editor-account",
      "author": {
        "name": "your-account",
        "email": "your-email@example.com"
      }
    }
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
  "merge": {
    "mergeQueue": true
  },
  "prompts": {
    "reviewGuidelines": ".agents/references/review-guidelines.md",
    "editGuidelines": ".agents/references/edit-guidelines.md"
  }
}
```

## Global Reference

These keys usually belong in `~/.config/opencode/magi.json` because they are reusable defaults across projects.

| Key                                    | Required             | Default                                                        | Description                                                                                                                                  |
| -------------------------------------- | -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                               | Yes                  | -                                                              | Agent defaults. Project config can override this object or replace `agents.reviewers`.                                                       |
| `agents.permissions`                   | No                   | [json](/src/permissions/common.json)                           | Common OpenCode permission rules applied to all Magi child agents before per-agent overrides.                                                |
| `agents.reviewers`                     | Yes (`review/merge`) | -                                                              | Odd-length array of at least 3 reviewers.                                                                                                    |
| `agents.reviewers[].id`                | No                   | `reviewer-1`, `reviewer-2`, ...                                | Reviewer key used for run state, output files, and session tracking.                                                                         |
| `agents.reviewers[].model`             | Yes                  | -                                                              | Full OpenCode model ID used by the reviewer, in `provider/model` form. Use `opencode/gpt-...` and `openai/gpt-...` to distinguish providers. |
| `agents.reviewers[].account`           | Yes                  | -                                                              | GitHub account used to post reviews and approvals. Must be authenticated with `gh auth token --user <account>`.                              |
| `agents.reviewers[].options`           | No                   | -                                                              | OpenCode provider/model options injected for this reviewer, such as `reasoningEffort`, `textVerbosity`, or Anthropic `thinking`.             |
| `agents.reviewers[].permission`        | No                   | -                                                              | OpenCode permission overrides for this reviewer. Also used by this reviewer's CI classifier sessions.                                        |
| `agents.reviewers[].persona`           | No                   | -                                                              | Reviewer-specific additional perspective.                                                                                                    |
| `agents.editor`                        | No                   | -                                                              | Editor used by `/magi:merge`. Required only when running `/magi:merge`.                                                                      |
| `agents.editor.model`                  | Yes (`/magi:merge`)  | -                                                              | Full OpenCode model ID used by the editor when `agents.editor` is configured.                                                                |
| `agents.editor.account`                | Yes (`/magi:merge`)  | -                                                              | GitHub account used for editor commits, replies, pushes, and merge operations.                                                               |
| `agents.editor.author.name`            | Yes (`/magi:merge`)  | -                                                              | Git commit author name configured in the temporary worktree before editor commits.                                                           |
| `agents.editor.author.email`           | Yes (`/magi:merge`)  | -                                                              | Git commit author email configured in the temporary worktree before editor commits.                                                          |
| `agents.editor.options`                | No                   | -                                                              | OpenCode provider/model options injected for the editor.                                                                                     |
| `agents.editor.permission`             | No                   | [json](/src/permissions/editor.json)                           | OpenCode permission overrides for the editor. Defaults allow editing and local commit creation, but not pushing.                             |
| `agents.editor.persona`                | No                   | -                                                              | Editor-specific additional instructions.                                                                                                     |
| `automation`                           | No                   | -                                                              | Runtime automation switches. Project config can override global defaults.                                                                    |
| `automation.merge`                     | No                   | `true`                                                         | Whether `/magi:merge` runs `gh pr merge` after reviewers approve. If false, Magi stops after approvals are posted.                           |
| `automation.close`                     | No                   | `true`                                                         | Whether `/magi:merge` runs `gh pr close` after a close decision. If false, Magi leaves the PR open after close comments are posted.          |
| `clear`                                | No                   | -                                                              | Cleanup defaults for `/magi:clear`. Project config can override global defaults.                                                             |
| `clear.output`                         | No                   | `true`                                                         | Delete inactive run output directories under `output.dirs`.                                                                                  |
| `clear.worktree`                       | No                   | `true`                                                         | Remove inactive run worktrees with `git worktree remove`, prune worktrees, and delete remaining worktree folders.                            |
| `clear.session`                        | No                   | `true`                                                         | Delete OpenCode child sessions created for inactive Magi runs.                                                                               |
| `clear.branch`                         | No                   | `true`                                                         | Delete the branch recorded when Magi created the worktree. Older runs without a recorded branch are skipped.                                 |
| `checks`                               | No                   | -                                                              | Check handling defaults. Project config can override global defaults.                                                                        |
| `checks.exclude`                       | No                   | `[]`                                                           | Check names to exclude from failure classification and CI merge blocking. Exact strings and `/regex/` patterns are supported.                |
| `checks.waitBeforeReview`              | No                   | `true`                                                         | Whether to wait for PR checks before review.                                                                                                 |
| `checks.waitAfterEdit`                 | No                   | `true`                                                         | Whether to wait for PR checks after the editor pushes a fix commit.                                                                          |
| `checks.retryFailedJobs`               | No                   | `3`                                                            | Number of times to rerun failed GitHub Actions jobs classified as scope-outside.                                                             |
| `concurrency`                          | No                   | -                                                              | Worker pool limits. Project config can override global limits.                                                                               |
| `concurrency.runs`                     | No                   | `3`                                                            | Maximum number of PR runs processed at the same time for `/magi:review` and `/magi:merge`.                                                   |
| `concurrency.reviewers`                | No                   | `3`                                                            | Maximum number of reviewer agents processed at the same time inside review and re-review phases.                                             |
| `github`                               | Yes                  | -                                                              | GitHub repository target. Required after global and project config are merged.                                                               |
| `github.host`                          | No                   | `github.com`                                                   | GitHub host.                                                                                                                                 |
| `github.owner`                         | Yes                  | -                                                              | GitHub repository owner.                                                                                                                     |
| `github.repo`                          | Yes                  | -                                                              | GitHub repository name.                                                                                                                      |
| `github.apiRetryAttempts`              | No                   | `3`                                                            | Number of retry attempts for GitHub CLI API calls that fail with rate limit errors. Set `0` to disable retry.                                |
| `language`                             | No                   | -                                                              | Default language hint for generated reviews and comments.                                                                                    |
| `merge`                                | No                   | -                                                              | Merge behavior for `/magi:merge`. Project config can override global defaults.                                                               |
| `merge.method`                         | No                   | `squash`                                                       | Merge method: `merge`, `squash`, or `rebase`.                                                                                                |
| `merge.auto`                           | No                   | `true`                                                         | Whether to enable GitHub auto-merge.                                                                                                         |
| `merge.deleteBranch`                   | No                   | `true`                                                         | Whether to delete the branch after merge.                                                                                                    |
| `merge.mergeQueue`                     | No                   | `false`                                                        | Whether Magi should use GitHub auto-merge and poll merge queue completion.                                                                   |
| `merge.maxThreadResolutionCycles`      | No                   | `5`                                                            | Maximum fix/reply attempts per unresolved review thread before stopping that thread. Set `0` for unlimited attempts.                         |
| `merge.approvalPolicy`                 | No                   | `majority`                                                     | `majority` merges on reviewer majority; `unanimous` requires all reviewers to approve before merging.                                        |
| `output`                               | No                   | -                                                              | Output handling defaults.                                                                                                                    |
| `output.dirs.pr`                       | No                   | `.magi/runs/pr`                                                | Directory for PR run artifacts. PR #123 is stored under `pr/123/<runId>`.                                                                    |
| `output.repairAttempts`                | No                   | `3`                                                            | Number of times to ask a model to repair invalid structured output.                                                                          |
| `worktree`                             | No                   | -                                                              | Worktree handling defaults.                                                                                                                  |
| `worktree.dir`                         | No                   | `.magi/worktrees`                                              | Directory for temporary PR worktrees.                                                                                                        |
| `prompts`                              | No                   | -                                                              | Project prompts merge over global prompts.                                                                                                   |
| `prompts.review`                       | No                   | [md](/src/prompts/templates/review.md)                         | Task template override for initial review.                                                                                                   |
| `prompts.rereview`                     | No                   | [md](/src/prompts/templates/rereview.md)                       | Task template override for re-review after edits.                                                                                            |
| `prompts.reviewGuidelines`             | No                   | -                                                              | Markdown file appended to reviewer prompts as shared review guidance. Supports absolute paths, project-relative paths, and `~/` paths.       |
| `prompts.edit`                         | No                   | [md](/src/prompts/templates/edit.md)                           | Task template override for editor fixes, disagreements, and clarification questions.                                                         |
| `prompts.editGuidelines`               | No                   | -                                                              | Markdown file appended to editor prompts as shared edit guidance. Supports absolute paths, project-relative paths, and `~/` paths.           |
| `prompts.findingValidation`            | No                   | [md](/src/prompts/templates/finding-validation.md)             | Task template override for voting on review findings.                                                                                        |
| `prompts.closeReconsideration`         | No                   | [md](/src/prompts/templates/close-reconsideration.md)          | Task template override when a close verdict is in the minority.                                                                              |
| `prompts.rereviewCloseReconsideration` | No                   | [md](/src/prompts/templates/rereview-close-reconsideration.md) | Task template override when a re-review close verdict is in the minority.                                                                    |
| `prompts.ciClassification`             | No                   | [md](/src/prompts/templates/ci-classification.md)              | Task template override for classifying failed checks as scope-in or scope-out.                                                               |
| `prompts.ciClassificationAfterEdit`    | No                   | [md](/src/prompts/templates/ci-classification-after-edit.md)   | Task template override for classifying failed checks after editor changes. Falls back to `prompts.ciClassification` when unset.              |
| `safety`                               | No                   | -                                                              | Optional gates evaluated before `/magi:review` and `/magi:merge` run agents.                                                                 |
| `safety.requiredLabels`                | No                   | `[]`                                                           | Labels that must all be present on the PR.                                                                                                   |
| `safety.blockedPaths`                  | No                   | `[]`                                                           | Glob patterns for changed files that block Magi automation.                                                                                  |
| `safety.maxChangedFiles`               | No                   | -                                                              | Maximum changed file count allowed before Magi blocks the run.                                                                               |
| `safety.allowAuthors`                  | No                   | `[]`                                                           | If set, only these PR authors are allowed to run through Magi.                                                                               |

## Project Reference

These keys usually belong in `<project>/.opencode/magi.json` because they describe the current repository or project-specific overrides.

| Key                                    | Required            | Default                                                        | Description                                                                                                                                  |
| -------------------------------------- | ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`                               | Yes                 | -                                                              | GitHub repository target. Required after global and project config are merged.                                                               |
| `github.host`                          | No                  | `github.com`                                                   | GitHub host.                                                                                                                                 |
| `github.owner`                         | Yes                 | -                                                              | GitHub repository owner.                                                                                                                     |
| `github.repo`                          | Yes                 | -                                                              | GitHub repository name.                                                                                                                      |
| `github.apiRetryAttempts`              | No                  | `3`                                                            | Number of retry attempts for GitHub CLI API calls that fail with rate limit errors. Set `0` to disable retry.                                |
| `agents`                               | No                  | -                                                              | Project-specific agent overrides.                                                                                                            |
| `agents.permissions`                   | No                  | [json](/src/permissions/common.json)                           | Project-specific common OpenCode permission overrides applied to all Magi child agents.                                                      |
| `agents.reviewers`                     | No                  | -                                                              | Project-specific reviewer list. If set, replaces the global reviewer list.                                                                   |
| `agents.reviewers[].id`                | No                  | `reviewer-1`, `reviewer-2`, ...                                | Reviewer key used for run state, output files, and session tracking.                                                                         |
| `agents.reviewers[].model`             | Yes                 | -                                                              | Full OpenCode model ID used by the reviewer, in `provider/model` form. Use `opencode/gpt-...` and `openai/gpt-...` to distinguish providers. |
| `agents.reviewers[].account`           | Yes                 | -                                                              | GitHub account used to post reviews and approvals. Must be authenticated with `gh auth token --user <account>`.                              |
| `agents.reviewers[].options`           | No                  | -                                                              | OpenCode provider/model options injected for this reviewer, such as `reasoningEffort`, `textVerbosity`, or Anthropic `thinking`.             |
| `agents.reviewers[].permission`        | No                  | -                                                              | Project-specific OpenCode permission overrides for this reviewer. Also used by this reviewer's CI classifier sessions.                       |
| `agents.reviewers[].persona`           | No                  | -                                                              | Reviewer-specific additional perspective.                                                                                                    |
| `agents.editor`                        | No                  | -                                                              | Project-specific editor for `/magi:merge`.                                                                                                   |
| `agents.editor.model`                  | Yes (`/magi:merge`) | -                                                              | Full OpenCode model ID used by the editor when `agents.editor` is configured.                                                                |
| `agents.editor.account`                | Yes (`/magi:merge`) | -                                                              | GitHub account used for editor commits, replies, pushes, and merge operations.                                                               |
| `agents.editor.author.name`            | Yes (`/magi:merge`) | -                                                              | Git commit author name configured in the temporary worktree before editor commits.                                                           |
| `agents.editor.author.email`           | Yes (`/magi:merge`) | -                                                              | Git commit author email configured in the temporary worktree before editor commits.                                                          |
| `agents.editor.options`                | No                  | -                                                              | OpenCode provider/model options injected for the editor.                                                                                     |
| `agents.editor.permission`             | No                  | [json](/src/permissions/editor.json)                           | Project-specific OpenCode permission overrides for the editor. Defaults allow editing and local commit creation, but not pushing.            |
| `agents.editor.persona`                | No                  | -                                                              | Editor-specific additional instructions.                                                                                                     |
| `automation`                           | No                  | -                                                              | Project-specific automation switches.                                                                                                        |
| `automation.merge`                     | No                  | `true`                                                         | Whether `/magi:merge` runs `gh pr merge` after approvals are posted.                                                                         |
| `automation.close`                     | No                  | `true`                                                         | Whether `/magi:merge` runs `gh pr close` after close comments are posted.                                                                    |
| `clear`                                | No                  | -                                                              | Project-specific cleanup defaults for `/magi:clear`.                                                                                         |
| `clear.output`                         | No                  | `true`                                                         | Delete inactive run output directories under `output.dirs`.                                                                                  |
| `clear.worktree`                       | No                  | `true`                                                         | Remove inactive run worktrees with `git worktree remove`, prune worktrees, and delete remaining worktree folders.                            |
| `clear.session`                        | No                  | `true`                                                         | Delete OpenCode child sessions created for inactive Magi runs.                                                                               |
| `clear.branch`                         | No                  | `true`                                                         | Delete the branch recorded when Magi created the worktree. Older runs without a recorded branch are skipped.                                 |
| `concurrency`                          | No                  | -                                                              | Project-specific worker pool limits.                                                                                                         |
| `concurrency.runs`                     | No                  | `3`                                                            | Maximum number of PR runs processed at the same time.                                                                                        |
| `concurrency.reviewers`                | No                  | `3`                                                            | Maximum number of reviewer agents processed at the same time per PR phase.                                                                   |
| `language`                             | No                  | -                                                              | Project-specific language hint.                                                                                                              |
| `merge`                                | No                  | -                                                              | Merge behavior for `/magi:merge`.                                                                                                            |
| `merge.method`                         | No                  | `squash`                                                       | Merge method: `merge`, `squash`, or `rebase`.                                                                                                |
| `merge.auto`                           | No                  | `true`                                                         | Whether to enable GitHub auto-merge.                                                                                                         |
| `merge.deleteBranch`                   | No                  | `true`                                                         | Whether to delete the branch after merge.                                                                                                    |
| `merge.mergeQueue`                     | No                  | `false`                                                        | Whether Magi should use GitHub auto-merge and poll merge queue completion.                                                                   |
| `merge.maxThreadResolutionCycles`      | No                  | `5`                                                            | Maximum fix/reply attempts per unresolved review thread before stopping that thread. Set `0` for unlimited attempts.                         |
| `merge.approvalPolicy`                 | No                  | `majority`                                                     | `majority` merges on reviewer majority; `unanimous` requires all reviewers to approve before merging.                                        |
| `checks`                               | No                  | -                                                              | Check handling options.                                                                                                                      |
| `checks.exclude`                       | No                  | `[]`                                                           | Check names to exclude from failure classification and CI merge blocking. Exact strings and `/regex/` patterns are supported.                |
| `checks.waitBeforeReview`              | No                  | `true`                                                         | Whether to wait for PR checks before review.                                                                                                 |
| `checks.waitAfterEdit`                 | No                  | `true`                                                         | Whether to wait for PR checks after the editor pushes a fix commit.                                                                          |
| `checks.retryFailedJobs`               | No                  | `3`                                                            | Number of times to rerun failed GitHub Actions jobs classified as scope-outside.                                                             |
| `output`                               | No                  | -                                                              | Project-specific output handling overrides.                                                                                                  |
| `output.dirs.pr`                       | No                  | `.magi/runs/pr`                                                | Directory for PR run artifacts. PR #123 is stored under `pr/123/<runId>`.                                                                    |
| `output.repairAttempts`                | No                  | `3`                                                            | Number of times to ask a model to repair invalid structured output.                                                                          |
| `worktree`                             | No                  | -                                                              | Project-specific worktree handling overrides.                                                                                                |
| `worktree.dir`                         | No                  | `.magi/worktrees`                                              | Directory for temporary PR worktrees.                                                                                                        |
| `prompts`                              | No                  | -                                                              | Project-specific prompt additions. These merge over global prompts.                                                                          |
| `prompts.review`                       | No                  | [md](/src/prompts/templates/review.md)                         | Task template override for initial review.                                                                                                   |
| `prompts.rereview`                     | No                  | [md](/src/prompts/templates/rereview.md)                       | Task template override for re-review after edits.                                                                                            |
| `prompts.reviewGuidelines`             | No                  | -                                                              | Markdown file appended to reviewer prompts as shared review guidance. Supports absolute paths, project-relative paths, and `~/` paths.       |
| `prompts.edit`                         | No                  | [md](/src/prompts/templates/edit.md)                           | Task template override for editor fixes, disagreements, and clarification questions.                                                         |
| `prompts.editGuidelines`               | No                  | -                                                              | Markdown file appended to editor prompts as shared edit guidance. Supports absolute paths, project-relative paths, and `~/` paths.           |
| `prompts.findingValidation`            | No                  | [md](/src/prompts/templates/finding-validation.md)             | Task template override for voting on review findings.                                                                                        |
| `prompts.closeReconsideration`         | No                  | [md](/src/prompts/templates/close-reconsideration.md)          | Task template override when a close verdict is in the minority.                                                                              |
| `prompts.rereviewCloseReconsideration` | No                  | [md](/src/prompts/templates/rereview-close-reconsideration.md) | Task template override when a re-review close verdict is in the minority.                                                                    |
| `prompts.ciClassification`             | No                  | [md](/src/prompts/templates/ci-classification.md)              | Task template override for classifying failed checks as scope-in or scope-out.                                                               |
| `prompts.ciClassificationAfterEdit`    | No                  | [md](/src/prompts/templates/ci-classification-after-edit.md)   | Task template override for classifying failed checks after editor changes. Falls back to `prompts.ciClassification` when unset.              |
| `safety`                               | No                  | -                                                              | Optional gates evaluated before `/magi:review` and `/magi:merge` run agents.                                                                 |
| `safety.requiredLabels`                | No                  | `[]`                                                           | Labels that must all be present on the PR.                                                                                                   |
| `safety.blockedPaths`                  | No                  | `[]`                                                           | Glob patterns for changed files that block Magi automation.                                                                                  |
| `safety.maxChangedFiles`               | No                  | -                                                              | Maximum changed file count allowed before Magi blocks the run.                                                                               |
| `safety.allowAuthors`                  | No                  | `[]`                                                           | If set, only these PR authors are allowed to run through Magi.                                                                               |

## Agent Permissions

Magi passes resolved OpenCode permission rules to every child session. `agents.permissions` is the common base for all Magi agents, and `agents.reviewers[].permission` or `agents.editor.permission` override that base for one agent.

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
    },
    "reviewers": [
      {
        "id": "security",
        "model": "anthropic/claude-opus-4-7",
        "account": "your-account-2",
        "permission": {
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
- `agents.editor` is required when running `/magi:merge`, but not when running only `/magi:review`.
- Permission values must be `allow`, `ask`, `deny`, or an object of pattern-to-action rules.

## GitHub Permissions

Each reviewer account must be able to read the target repository and post PR reviews or comments. Each editor account must be able to reply to comments, resolve review threads, push to the PR branch, and merge or close the PR when `/magi:merge` reaches that step.

When auth validation runs, Magi checks repository-level permissions through GitHub's repository API:

- Reviewer accounts must have `.permissions.pull`.
- Editor accounts must have `.permissions.push`.

This is an early sanity check, not a complete guarantee. Branch protection, merge queue rules, fork PR branch permissions, review dismissal policies, and other repository rules can still reject pushes, merges, review posts, or thread resolution at runtime.
