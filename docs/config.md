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
  "agents": {
    "refs": {
      "account-1": {
        "model": "openai/gpt-5.5",
        "account": "account-1"
      },
      "account-2": {
        "model": "anthropic/claude-opus-4-7",
        "account": "account-2"
      },
      "account-3": {
        "model": "opencode/kimi-k2-6",
        "account": "account-3"
      }
    }
  },
  "review": {
    "agents": [
      { "ref": "account-1" },
      { "ref": "account-2" },
      { "ref": "account-3" }
    ]
  }
}
```

## Project Example

```json
{
  "$schema": "https://raw.githubusercontent.com/magi-ai/opencode-magi/main/schema.json",
  "github": {
    "owner": "your-owner",
    "repo": "your-repo"
  },
  "agents": {
    "refs": {
      "account-1": {
        "model": "openai/gpt-5.5",
        "account": "account-1"
      },
      "account-2": {
        "model": "anthropic/claude-opus-4-7",
        "account": "account-2"
      },
      "account-3": {
        "model": "opencode/kimi-k2-6",
        "account": "account-3"
      },
      "account-4": {
        "model": "openai/gpt-5.5",
        "account": "account-4",
        "author": {
          "name": "account-4",
          "email": "your-email@example.com"
        }
      }
    }
  },
  "review": {
    "agents": [
      { "ref": "account-1" },
      { "ref": "account-2" },
      { "ref": "account-3" }
    ]
  },
  "merge": {
    "editor": { "ref": "account-4" }
  },
  "triage": {
    "account": "account-5",
    "agents": [
      { "ref": "account-1" },
      { "ref": "account-2" },
      { "ref": "account-3" }
    ]
  }
}
```

Entries with `ref` are expanded from `agents.refs`. Fields set alongside `ref` override fields from the preset.

## Reference

| Key                                    | Scope   | Required                         | Default                                              | Description                                                                                                          |
| -------------------------------------- | ------- | -------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `github`                               | Project | Yes                              | -                                                    | GitHub repository target.                                                                                            |
| `github.host`                          | Project | No                               | `github.com`                                         | GitHub host.                                                                                                         |
| `github.owner`                         | Project | Yes                              | -                                                    | GitHub repository owner.                                                                                             |
| `github.repo`                          | Project | Yes                              | -                                                    | GitHub repository name.                                                                                              |
| `github.apiRetryAttempts`              | Project | No                               | `3`                                                  | Number of retry attempts for GitHub CLI API calls that fail with rate limit errors.                                  |
| `language`                             | Both    | No                               | -                                                    | Default language hint for generated reviews and comments.                                                            |
| `agents`                               | Both    | No                               | -                                                    | Common agent configuration.                                                                                          |
| `agents.refs`                          | Both    | No                               | -                                                    | Reusable agent presets. Agent entries with `ref` are expanded from these presets before validation.                  |
| `agents.permissions`                   | Both    | No                               | [json](/src/permissions/common.json)                 | Common OpenCode permission rules applied before per-agent `permissions`.                                             |
| `output`                               | Both    | No                               | -                                                    | Output parsing and repair configuration.                                                                             |
| `output.repairAttempts`                | Both    | No                               | `3`                                                  | Number of times to ask a model to repair invalid structured output.                                                  |
| `review`                               | Both    | Yes                              | -                                                    | PR review configuration used by `/magi:review` and the review phase of `/magi:merge`.                                |
| `review.agents`                        | Both    | Yes                              | -                                                    | Odd-length array of at least 3 reviewer agents.                                                                      |
| `review.agents[].id`                   | Both    | No                               | `reviewer-1`, ...                                    | Reviewer key used for run state, output files, and session tracking.                                                 |
| `review.agents[].model`                | Both    | Yes                              | -                                                    | Full OpenCode model ID used by the reviewer.                                                                         |
| `review.agents[].account`              | Both    | Yes                              | -                                                    | GitHub account used to post reviews and approvals.                                                                   |
| `review.agents[].options`              | Both    | No                               | -                                                    | OpenCode provider/model options injected for this reviewer.                                                          |
| `review.agents[].permissions`          | Both    | No                               | -                                                    | OpenCode permission overrides for this reviewer and this reviewer's CI classifier sessions.                          |
| `review.agents[].persona`              | Both    | No                               | -                                                    | Reviewer-specific additional perspective.                                                                            |
| `review.prompts`                       | Both    | No                               | -                                                    | Review prompt template and guideline file path overrides.                                                            |
| `review.prompts.review`                | Both    | No                               | [md](/docs/prompts/review/review.md)                 | Task template override for initial review.                                                                           |
| `review.prompts.rereview`              | Both    | No                               | [md](/docs/prompts/review/rereview.md)               | Task template override for re-review after edits.                                                                    |
| `review.prompts.reviewGuidelines`      | Both    | No                               | -                                                    | Markdown file appended to reviewer prompts as shared review guidance.                                                |
| `review.prompts.ciClassification`      | Both    | No                               | [md](/docs/prompts/review/ci-classification.md)      | Task template override for classifying failed checks before review.                                                  |
| `review.prompts.findingValidation`     | Both    | No                               | [md](/docs/prompts/review/finding-validation.md)     | Task template override for voting on review findings.                                                                |
| `review.prompts.closeReconsideration`  | Both    | No                               | [md](/docs/prompts/review/close-reconsideration.md)  | Task template override when a close verdict is in the minority. Used for review and re-review.                       |
| `review.checks`                        | Both    | No                               | -                                                    | Review check waiting, exclusion, and retry configuration.                                                            |
| `review.checks.exclude`                | Both    | No                               | `[]`                                                 | Check names to exclude from failure classification. Exact strings and `/regex/` patterns supported.                  |
| `review.checks.wait`                   | Both    | No                               | `true`                                               | Whether to wait for PR checks before review.                                                                         |
| `review.checks.retryFailedJobs`        | Both    | No                               | `3`                                                  | Number of times to rerun failed GitHub Actions jobs classified as scope-outside.                                     |
| `review.safety`                        | Both    | No                               | -                                                    | Review safety guard configuration.                                                                                   |
| `review.safety.requiredLabels`         | Both    | No                               | `[]`                                                 | Labels that must all be present on the PR.                                                                           |
| `review.safety.blockedPaths`           | Both    | No                               | `[]`                                                 | Glob patterns for changed files that block Magi automation.                                                          |
| `review.safety.maxChangedFiles`        | Both    | No                               | -                                                    | Maximum changed file count allowed before Magi blocks the run.                                                       |
| `review.safety.allowAuthors`           | Both    | No                               | `[]`                                                 | If set, only these PR authors are allowed to run through Magi.                                                       |
| `review.automation`                    | Both    | No                               | -                                                    | Automation behavior after review decisions.                                                                          |
| `review.automation.merge`              | Both    | No                               | `true`                                               | Whether `/magi:review` runs `gh pr merge` after reviewer majority approves.                                          |
| `review.automation.close`              | Both    | No                               | `false`                                              | Whether `/magi:review` runs `gh pr close` after a close majority.                                                    |
| `review.concurrency`                   | Both    | No                               | -                                                    | Review concurrency limits.                                                                                           |
| `review.concurrency.runs`              | Both    | No                               | `3`                                                  | Maximum PR runs processed at the same time.                                                                          |
| `review.concurrency.reviewers`         | Both    | No                               | `3`                                                  | Maximum reviewer agents running at once per PR phase.                                                                |
| `review.merge`                         | Both    | No                               | -                                                    | Merge behavior used after review approval.                                                                           |
| `review.merge.method`                  | Both    | No                               | `squash`                                             | Merge method: `merge`, `squash`, or `rebase`.                                                                        |
| `review.merge.auto`                    | Both    | No                               | `true`                                               | Whether Magi passes `--auto` to `gh pr merge`. Ignored when `review.merge.queue` is `true`.                          |
| `review.merge.deleteBranch`            | Both    | No                               | `true`                                               | Whether Magi passes `--delete-branch` to `gh pr merge`. Ignored when `review.merge.queue` is `true`.                 |
| `review.merge.queue`                   | Both    | No                               | `false`                                              | Whether Magi uses GitHub GraphQL to enqueue the PR and poll merge queue completion.                                  |
| `review.merge.approvalPolicy`          | Both    | No                               | `majority`                                           | `majority` merges on reviewer majority; `unanimous` requires all reviewers to approve.                               |
| `review.output`                        | Both    | No                               | `.magi/runs/pr`                                      | Directory for PR run artifacts. PR #123 is stored under `<dir>/123/<runId>`.                                         |
| `review.worktree`                      | Both    | No                               | `.magi/worktrees/pr`                                 | Directory for temporary PR worktrees. PR #123 is stored under `<dir>/pr-123`.                                        |
| `triage`                               | Both    | Yes (`/magi:triage`)             | -                                                    | Issue triage configuration.                                                                                          |
| `triage.account`                       | Both    | Yes (`/magi:triage`)             | -                                                    | GitHub account used to post triage comments, close issues and linked PRs, remove labels, and create PRs by default.  |
| `triage.agents`                        | Both    | Yes (`/magi:triage`)             | -                                                    | Dedicated issue triage agents. Odd-length array of at least 3 agents.                                                |
| `triage.agents[].id`                   | Both    | No                               | `voter-1`, ...                                       | Triage agent key used for output files and session tracking.                                                         |
| `triage.agents[].model`                | Both    | Yes                              | -                                                    | Full OpenCode model ID used by the triage agent.                                                                     |
| `triage.agents[].options`              | Both    | No                               | -                                                    | OpenCode provider/model options injected for this triage agent.                                                      |
| `triage.agents[].permissions`          | Both    | No                               | [json](/src/permissions/common.json)                 | OpenCode permission overrides for this triage agent.                                                                 |
| `triage.agents[].persona`              | Both    | No                               | -                                                    | Triage vote perspective for this agent.                                                                              |
| `triage.creator`                       | Both    | Yes (`triage.automation.create`) | -                                                    | Agent used to create implementation PRs from accepted issues.                                                        |
| `triage.creator.account`               | Both    | No                               | `triage.account`                                     | GitHub account used to create PRs when different from `triage.account`.                                              |
| `triage.creator.model`                 | Both    | Yes (`triage.automation.create`) | -                                                    | Full OpenCode model ID used by the PR creator agent.                                                                 |
| `triage.creator.options`               | Both    | No                               | -                                                    | OpenCode provider/model options injected for the PR creator agent.                                                   |
| `triage.creator.permissions`           | Both    | No                               | [json](/src/permissions/editor.json)                 | OpenCode permission overrides for the PR creator agent.                                                              |
| `triage.creator.persona`               | Both    | No                               | -                                                    | Additional instructions for PR creation only.                                                                        |
| `triage.creator.author.name`           | Both    | Yes (`triage.automation.create`) | -                                                    | Git author name used for commits created by the PR creator.                                                          |
| `triage.creator.author.email`          | Both    | Yes (`triage.automation.create`) | -                                                    | Git author email used for commits created by the PR creator.                                                         |
| `triage.categories`                    | Both    | No                               | [array](/src/config/resolve.ts#L23)                  | Issue triage categories used for label/type pre-resolution and Category Vote.                                        |
| `triage.categories[].id`               | Both    | Yes                              | -                                                    | Stable category ID used in votes, artifacts, markers, and action decisions.                                          |
| `triage.categories[].labels`           | Both    | No                               | `[]`                                                 | Labels that classify an issue as this category and skip Category Vote when exactly one category matches.             |
| `triage.categories[].types`            | Both    | No                               | `[]`                                                 | Issue types that classify an issue as this category when GraphQL issue types are available.                          |
| `triage.categories[].description`      | Both    | No                               | -                                                    | Short explanation shown to agents during Category Vote.                                                              |
| `triage.automation.close`              | Both    | No                               | `false`                                              | Whether rejected or duplicate issues are closed after an author-mentioned close comment.                             |
| `triage.automation.create`             | Both    | No                               | `false`                                              | Whether accepted issues can create implementation PRs.                                                               |
| `triage.automation.review`             | Both    | No                               | `false`                                              | Whether created implementation PRs automatically start `/magi:review`. Requires `triage.automation.create`.          |
| `triage.automation.merge`              | Both    | No                               | `false`                                              | Whether created implementation PRs automatically start `/magi:merge`. Requires `triage.automation.create`.           |
| `triage.automation.clear`              | Both    | No                               | `["triage"]`                                         | Labels removed after non-ASK triage results that reach action execution. Safety-gate `failed` results do not clear labels. Set `[]` to disable label removal. |
| `triage.safety.requiredLabels`         | Both    | No                               | `["triage"]`                                         | Labels required before initial triage runs.                                                                          |
| `triage.safety.blockedLabels`          | Both    | No                               | `[]`                                                 | Labels that prevent triage from running.                                                                             |
| `triage.safety.allowAuthors`           | Both    | No                               | `[]`                                                 | If set, only issues created by these GitHub logins can be triaged.                                                   |
| `triage.safety.allowMentionActors`     | Both    | No                               | `[]`                                                 | GitHub logins allowed to trigger reconsideration by mentioning `triage.account`.                                     |
| `triage.safety.allowMentionRoles`      | Both    | No                               | `["AUTHOR", "OWNER", "MEMBER", "COLLABORATOR"]`      | GitHub author associations allowed to trigger reconsideration by mentioning `triage.account`.                        |
| `triage.concurrency.runs`              | Both    | No                               | `3`                                                  | Maximum issues processed concurrently.                                                                               |
| `triage.prompts`                       | Both    | No                               | -                                                    | Triage prompt template file path overrides.                                                                          |
| `triage.prompts.existingPr`            | Both    | No                               | [md](/docs/prompts/triage/existing-pr.md)            | Task template override for checking whether related pull requests handle the issue.                                  |
| `triage.prompts.duplicate`             | Both    | No                               | [md](/docs/prompts/triage/duplicate.md)              | Task template override for duplicate issue checks.                                                                   |
| `triage.prompts.category`              | Both    | No                               | [md](/docs/prompts/triage/category.md)               | Task template override for choosing a configured issue category.                                                     |
| `triage.prompts.acceptance`            | Both    | No                               | [md](/docs/prompts/triage/acceptance.md)             | Task template override for deciding whether the selected category should be accepted.                                |
| `triage.prompts.question`              | Both    | No                               | [md](/docs/prompts/triage/question.md)               | Task template override for asking the issue author for clarification.                                                |
| `triage.prompts.comment`               | Both    | No                               | [md](/docs/prompts/triage/comment.md)                | Task template override for composing triage result comments.                                                         |
| `triage.prompts.commentClassification` | Both    | No                               | [md](/docs/prompts/triage/comment-classification.md) | Task template override for classifying mention replies after triage.                                                 |
| `triage.prompts.reconsider`            | Both    | No                               | [md](/docs/prompts/triage/reconsider.md)             | Task template override for reconsidering previous triage results.                                                    |
| `triage.prompts.create`                | Both    | No                               | [md](/docs/prompts/triage/create.md)                 | Task template override for creating implementation PRs.                                                              |
| `triage.prompts.createGuidelines`      | Both    | No                               | -                                                    | Markdown file appended to PR creation prompts as shared implementation guidance.                                     |
| `triage.output`                        | Both    | No                               | `.magi/runs/issue`                                   | Directory for issue triage run artifacts.                                                                            |
| `triage.worktree`                      | Both    | No                               | `.magi/worktrees/issue`                              | Directory for issue validation and PR creation worktrees.                                                            |
| `merge`                                | Both    | No                               | -                                                    | Additional `/magi:merge` configuration.                                                                              |
| `merge.editor`                         | Both    | Yes (`/magi:merge`)              | -                                                    | Editor agent used by `/magi:merge`.                                                                                  |
| `merge.editor.model`                   | Both    | Yes (`/magi:merge`)              | -                                                    | Full OpenCode model ID used by the editor.                                                                           |
| `merge.editor.account`                 | Both    | Yes (`/magi:merge`)              | -                                                    | GitHub account used for editor commits, replies, pushes, and merge operations.                                       |
| `merge.editor.author`                  | Both    | Yes (`/magi:merge`)              | -                                                    | Git commit author identity configured in the temporary worktree before editor commits.                               |
| `merge.editor.author.name`             | Both    | Yes (`/magi:merge`)              | -                                                    | Git commit author name configured in the temporary worktree before editor commits.                                   |
| `merge.editor.author.email`            | Both    | Yes (`/magi:merge`)              | -                                                    | Git commit author email configured in the temporary worktree before editor commits.                                  |
| `merge.editor.options`                 | Both    | No                               | -                                                    | OpenCode provider/model options injected for the editor.                                                             |
| `merge.editor.permissions`             | Both    | No                               | [json](/src/permissions/editor.json)                 | OpenCode permission overrides for the editor.                                                                        |
| `merge.editor.persona`                 | Both    | No                               | -                                                    | Editor-specific additional instructions.                                                                             |
| `merge.checks`                         | Both    | No                               | -                                                    | Check waiting configuration after editor changes.                                                                    |
| `merge.checks.wait`                    | Both    | No                               | `true`                                               | Whether to wait for PR checks after the editor pushes a fix commit.                                                  |
| `merge.prompts`                        | Both    | No                               | -                                                    | Merge prompt template and guideline file path overrides.                                                             |
| `merge.prompts.edit`                   | Both    | No                               | [md](/docs/prompts/merge/edit.md)                    | Task template override for editor fixes, disagreements, and clarification questions.                                 |
| `merge.prompts.editGuidelines`         | Both    | No                               | -                                                    | Markdown file appended to editor prompts as shared edit guidance.                                                    |
| `merge.prompts.ciClassification`       | Both    | No                               | [md](/docs/prompts/merge/ci-classification.md)       | Task template override for classifying failed checks after editor changes.                                           |
| `merge.automation`                     | Both    | No                               | -                                                    | Automation behavior after merge workflow decisions.                                                                  |
| `merge.automation.merge`               | Both    | No                               | `true`                                               | Whether `/magi:merge` runs `gh pr merge` after reviewers approve.                                                    |
| `merge.automation.close`               | Both    | No                               | `false`                                              | Whether `/magi:merge` runs `gh pr close` after a close decision.                                                     |
| `merge.maxThreadResolutionCycles`      | Both    | No                               | `5`                                                  | Maximum fix/reply attempts per unresolved review thread before stopping that thread. Set `0` for unlimited attempts. |
| `clear`                                | Both    | No                               | -                                                    | Cleanup behavior used by `/magi:clear`.                                                                              |
| `clear.output`                         | Both    | No                               | `true`                                               | Delete inactive run output directories.                                                                              |
| `clear.worktree`                       | Both    | No                               | `true`                                               | Remove inactive run worktrees and prune worktree folders.                                                            |
| `clear.session`                        | Both    | No                               | `true`                                               | Delete OpenCode child sessions created for inactive Magi runs.                                                       |
| `clear.branch`                         | Both    | No                               | `true`                                               | Delete the branch recorded when Magi created the worktree.                                                           |

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
