# Validate

## Usage

```txt
/magi:validate
```

## What It Does

`/magi:validate` checks global and project Magi configuration files, validates the merged effective config, and verifies GitHub authentication by default.

It is safe to run after creating or updating `~/.config/opencode/magi.json` or `<project>/.opencode/magi.json`.

## Flow

1. Read the global config at `~/.config/opencode/magi.json`.
2. Read the project config at `<project>/.opencode/magi.json`.
3. Report whether each config file is found, missing, or invalid JSON.
4. Merge existing configs, with project config overriding global config.
5. Validate known keys, value types, reviewer and triage agent counts, reviewer IDs, duplicate accounts, model IDs, prompts, output settings, worktree settings, check settings, review settings, merge settings, triage settings, automation settings, and clear settings.
6. Require `github.owner` and `github.repo` when a project config exists.
7. Verify GitHub CLI authentication for configured reviewer, editor, triage agent, and triage creator accounts.
8. Verify repository permissions when GitHub authentication succeeds.
9. Print errors and warnings.

## Outputs

`/magi:validate` prints a report with these sections:

| Section            | Contents                                           |
| ------------------ | -------------------------------------------------- |
| Validation summary | `passed` or `failed`.                              |
| Config files       | Global and project file status.                    |
| Effective config   | Files used for the merged config and auth setting. |
| Errors             | Blocking validation failures.                      |
| Warnings           | Non-blocking validation warnings.                  |

It does not modify files, create runs, post to GitHub, or start agents.

## Configuration

`/magi:validate` validates the same settings documented in [Config](/docs/config.md). The most important requirements are:

| Setting                   | Requirement                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `review.agents`           | Required for review/merge, at least 3 reviewers, odd count.    |
| `review.agents[].model`   | Required full OpenCode model ID in `provider/model` form.      |
| `review.agents[].account` | Required GitHub account, unique across reviewers.              |
| `merge.editor`            | Required by `/magi:merge`, optional for `/magi:review`.        |
| `github.owner`            | Required for PR review/merge runs.                             |
| `github.repo`             | Required for PR review/merge runs.                             |
| `review.prompts.*`        | Must point to readable files when configured.                  |
| `merge.prompts.*`         | Must point to readable files when configured.                  |
| `triage.agents`           | Required for triage, at least 3 agents, odd count.             |
| `triage.agents[].account` | Required GitHub account for each triage agent.                 |
| `triage.reporter`         | Optional triage agent key; otherwise selected by issue number. |
| `triage.creator`          | Optional creator agent for triage PR automation.               |
| `triage.prompts.*`        | Must point to readable files when configured.                  |

## FAQ

### Does `/magi:validate` require both config files?

No. At least one of `~/.config/opencode/magi.json` or `<project>/.opencode/magi.json` must exist.

### Which config wins when both files exist?

Project config overrides global config. Object values are deep merged; array values are replaced.

### Does it check GitHub authentication?

Yes. The slash command enables auth checks by default and runs `gh auth token --user <account>` for configured reviewer, editor, triage agent, and triage creator accounts.

### Does it check repository permissions?

Yes, after auth succeeds. Reviewer accounts must be able to read the repository. The editor account must be able to push for editor operations. Each triage agent account must be able to read the repository, and the triage creator account must be able to push when implementation PR creation is configured.

### Why can validation pass without an editor?

`merge.editor` is required when running `/magi:merge`, but not when running only `/magi:review`. `/magi:validate` validates general config by default; `/magi:merge` performs a stricter validation before starting.
