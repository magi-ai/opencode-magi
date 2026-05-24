# Triage

## Usage

```txt
/magi:triage <ISSUE...>
/magi:triage --dry-run <ISSUE...>
/magi:triage --sync --timeout 300 <ISSUE...>
/magi:triage --no-close --create --review <ISSUE...>
```

`<ISSUE...>` accepts one or more issue numbers, `#123` tokens, or issue URLs separated by spaces or commas.

Use `--dry-run` to run relationship scanning, triage agents, majority voting, comment composition, and reporting without mutating GitHub. Dry runs do not post issue comments, close issues or related PRs, remove labels, create implementation PRs, push branches, or trigger creator-agent PR work.

Per-run flags override merged config before validation and resolution. If both positive and negative boolean flags are supplied, the later flag wins. `--dry-run` remains the strongest safety mode and prevents GitHub mutations even when automation-enabling flags are supplied.

Triage flags:

| Flag                      | Effect or override                                      |
| ------------------------- | ------------------------------------------------------- |
| `--sync`                  | Wait for the triage run to finish before returning.     |
| `--timeout <seconds>`     | Stop waiting after this many seconds when synchronized. |
| `--language <value>`      | `language`                                              |
| `--close`, `--no-close`   | `triage.automation.close`                               |
| `--create`, `--no-create` | `triage.automation.create`                              |
| `--review`, `--no-review` | `triage.automation.review`                              |
| `--merge`, `--no-merge`   | `triage.automation.merge`                               |
| `--run-concurrency <n>`   | `triage.concurrency.runs`                               |

## What It Does

`/magi:triage` triages GitHub issues with dedicated `triage.agents`. It does not reuse `review.agents`.

Magi fetches bounded issue relationship data, asks triage agents to vote on existing PRs, duplicate issues, issue kind, and bug or feature decisions, then posts comments according to the final result unless the run is a clear-only linked PR case or is blocked by a safety gate. `ASK` comments come from each non-empty `ASK` vote body and use that voting agent's account. Non-`ASK` result comments use the selected reason when one is available, otherwise a natural fallback, and are posted by the selected reporter account. Configure `triage.reporter` to choose the reporter by resolved triage agent key; otherwise Magi selects one from the issue number.

## Flow

1. Parse issue arguments and load `triage.*` config.
2. Check issue safety gates such as required labels and blocked labels. Failed safety gates return immediately before agent voting and label clearing.
3. Scan bounded relationships: related PRs, duplicate candidates, and previous Magi markers.
4. Vote whether related PRs already handle the issue.
5. Vote whether duplicate candidates are true duplicates.
6. Resolve issue category from `triage.categories` labels/types or run Category Vote.
7. Run the common Acceptance Vote for the selected category.
8. Compose `ASK` vote comments or a non-`ASK` decision comment.
9. Apply enabled automation: close, PR creation, post-PR review or merge, and label clearing.
10. Write artifacts and a report.

`ASK` is a normal result. It posts each non-empty `ASK` vote body as a separate question comment and does not close, create PRs, or clear labels. Comment bodies are not automatically prefixed with an issue author mention.

Issue type rules use GitHub GraphQL `issueType`. If issue types are unavailable, Magi falls back to labels and Category Vote instead of failing triage.

Triage results:

| Disposition  | Meaning                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask`        | Magi needs more information. It posts `ASK` vote question bodies and skips close, PR creation, and label clearing.                                                                     |
| `accepted`   | The selected category was accepted. PR creation may run when `triage.automation.create` is enabled. Related-PR voting can also return this when a merged related PR handles the issue. |
| `rejected`   | The selected category was rejected. The issue may be closed when `triage.automation.close` is enabled.                                                                                 |
| `duplicate`  | Duplicate voting found majority support for the same candidate issue. The issue may be closed when enabled.                                                                            |
| `clear_only` | Related-PR voting found that an existing PR handles the issue without the merged-PR close path. Magi only clears configured labels.                                                    |
| `failed`     | A safety gate blocked the run before agent voting. Magi writes a report and does not post comments, close issues or PRs, create PRs, or clear labels.                                  |

## Outputs

Magi may post issue comments, close issues, close related open PRs, remove configured labels, create an implementation PR, or start review/merge automation for that PR depending on the final result and automation settings. `ASK` results may post multiple comments through the `ASK`-voting agent accounts. Non-`ASK` results may post one natural decision comment through the selected reporter account. Clear-only related PR runs do not post a comment or close the issue or related PRs.

Triage artifacts are written to the issue run output directory:

| File                        | Contents                                                         |
| --------------------------- | ---------------------------------------------------------------- |
| `issue.json`                | Issue metadata fetched from GitHub.                              |
| `relationship-summary.json` | Recent comments, related PRs, duplicate candidates, and marker.  |
| `existing-pr-majority.json` | Existing-PR vote counts and result, when that phase runs.        |
| `duplicate-majority.json`   | Duplicate vote counts and result, when that phase runs.          |
| `category-resolution.json`  | Category pre-resolution source and selected category, if any.    |
| `category-majority.json`    | Category vote counts and result, when Category Vote runs.        |
| `acceptance-majority.json`  | Acceptance vote counts and result, when Acceptance Vote runs.    |
| `create-pr.json`            | Creator-agent edit output, when implementation PR creation runs. |
| `report.md`                 | Final human-readable issue triage report.                        |

## Configuration

Important settings:

| Setting                                | Purpose                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `triage.agents`                        | Dedicated issue triage voting agents. Must be an odd-length array of at least 3 agents.                 |
| `triage.agents[].account`              | GitHub account used by each triage agent for ASK comments and reporter-owned mutations.                 |
| `triage.reporter`                      | Optional resolved triage agent key used for non-`ASK` comments and mutations; defaults by issue number. |
| `triage.creator`                       | Agent used for implementation PR creation when enabled.                                                 |
| `triage.creator.account`               | Required when `triage.automation.create` is true; pushes branches and opens PRs.                        |
| `triage.categories`                    | Category IDs and label/type rules that can skip Category Vote. Type rules require GitHub issue types.   |
| `triage.automation.close`              | Enables closing rejected or duplicate issues.                                                           |
| `triage.automation.create`             | Enables implementation PR creation for accepted issues.                                                 |
| `triage.automation.review`             | Starts `/magi:review` after implementation PR creation. Requires `triage.automation.create`.            |
| `triage.automation.merge`              | Starts `/magi:merge` after implementation PR creation. Requires `triage.automation.create`.             |
| `triage.automation.clear`              | Labels removed for non-ASK results.                                                                     |
| `triage.safety.requiredLabels`         | Labels required before initial triage runs.                                                             |
| `triage.safety.blockedLabels`          | Labels that prevent triage from running.                                                                |
| `triage.safety.allowAuthors`           | Allowed issue authors when configured.                                                                  |
| `triage.safety.allowMentionActors`     | GitHub logins allowed to trigger reconsideration.                                                       |
| `triage.safety.allowMentionRoles`      | GitHub author associations allowed to trigger reconsideration.                                          |
| `triage.prompts.existingPr`            | Related-PR voting prompt template.                                                                      |
| `triage.prompts.duplicate`             | Duplicate issue voting prompt template.                                                                 |
| `triage.prompts.category`              | Category voting prompt template.                                                                        |
| `triage.prompts.acceptance`            | Acceptance voting prompt template.                                                                      |
| `triage.prompts.commentClassification` | Mention reply classification prompt template.                                                           |
| `triage.prompts.reconsider`            | Reconsideration prompt template.                                                                        |
| `triage.prompts.create`                | Implementation PR creation prompt template.                                                             |
| `triage.prompts.createGuidelines`      | Shared PR creation guidance file.                                                                       |
| `triage.concurrency.runs`              | Maximum issues processed concurrently.                                                                  |
| `triage.output`                        | Issue triage artifact directory.                                                                        |
| `triage.worktree`                      | Worktree directory for validation and PR creation.                                                      |

See [Config](/docs/config.md) for the complete reference.

## FAQ

### What happens on `ASK`?

Magi posts each non-empty `ASK` vote body as its own question comment through that voting agent's account. The prompt contract asks agents to write the body for the issue author, but Magi does not automatically add or validate an author mention. It does not close the issue, create a PR, or clear labels. A later mention reply can be used for reconsideration when it passes the configured safety rules.

### How are existing related PRs handled?

Magi scans bounded issue timeline relationship data and asks triage agents whether a related PR already handles the issue. If the majority says it does and either no related PR is merged or close automation is disabled, Magi returns `clear_only`: it does not post a comment, does not close the issue or related PRs, and only clears configured labels.

If the majority says a related PR handles the issue, any related PR is `MERGED`, and `triage.automation.close` is enabled, Magi returns an `accepted` decision with close automation. That path posts a result comment, clears configured labels, closes the issue, and closes any related PRs that are still open.

### How does duplicate voting work?

Agents vote on the duplicate candidates found by GitHub issue search. `DUPLICATE` is used only when duplicate votes reach majority and a majority of agents choose the same candidate issue number.

### What GitHub data windows are fetched?

Magi currently fetches issue comments `last: 50`, related PR timeline items `first: 50`, and up to `5` duplicate issue candidates. The model context includes the last `20` fetched issue comments, so older comments and relationships can be omitted on very large issues.

### When does reconsideration run?

Reconsideration requires a previous trusted Magi marker and eligible mention replies after that marker checkpoint. Replies must mention the selected reporter account, must not have been processed already, and must pass the configured `triage.safety.allowMentionActors` or `triage.safety.allowMentionRoles` rules. Magi then classifies those replies and only reconsiders when at least one is classified as `CLARIFICATION`, `NEW_EVIDENCE`, or `OBJECTION`.

### Which GitHub accounts are used?

`triage.agents[].account` values are used for triage comments and mutations. Each triage agent account must be authenticated with GitHub CLI and able to read the repository. `triage.reporter` names the resolved triage agent key whose account posts non-`ASK` result comments, writes markers, removes labels, and closes issues or related PRs. If `triage.reporter` is unset, Magi selects a stable reporter from `triage.agents` by issue number. Individual `ASK` comments are posted through the accounts of the triage agents that produced them. `triage.creator.account` is required when PR automation is enabled, pushes implementation branches and opens PRs, and must have repository push permission.

### What do the automation flags control?

`triage.automation.close` allows Magi to close rejected or duplicate issues, and to close accepted issues when related-PR voting finds that a merged related PR handles the issue. Whenever close automation closes an issue, it also closes related PRs that are still open. `triage.automation.create` allows regular accepted issues to trigger creator-agent implementation PR creation. `triage.automation.review` starts review automation after that PR is created, while `triage.automation.merge` starts merge automation and takes precedence when both are enabled. `triage.automation.clear` lists labels removed after non-`ASK` outcomes that reach action execution; safety-gate `failed` results return before label clearing.
