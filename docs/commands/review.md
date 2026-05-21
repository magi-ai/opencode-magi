# Review

## Usage

```txt
/magi:review <PR...>
/magi:review --dry-run <PR...>
/magi:review --no-merge --run-concurrency 1 <PR...>
```

`<PR...>` accepts one or more PR numbers or PR URLs separated by spaces or commas.

Use `--dry-run` to run CI classification, reviewer agents, majority voting, and reporting without posting GitHub reviews or comments. Scope-out CI jobs are classified, but reruns are reported as planned actions instead of being triggered.

Per-run flags override merged config before validation and resolution. If both positive and negative boolean flags are supplied, the later flag wins. `--dry-run` remains the strongest safety mode and prevents GitHub mutations even when automation-enabling flags are supplied.

Review flags:

| Flag                                | Overrides                       |
| ----------------------------------- | ------------------------------- |
| `--language <value>`                | `language`                      |
| `--merge`, `--no-merge`             | `review.automation.merge`       |
| `--close`, `--no-close`             | `review.automation.close`       |
| `--retry-failed-jobs <n>`           | `review.checks.retryFailedJobs` |
| `--reviewer-concurrency <n>`        | `review.concurrency.reviewers`  |
| `--run-concurrency <n>`             | `review.concurrency.runs`       |
| `--wait-checks`, `--no-wait-checks` | `review.checks.wait`            |

## What It Does

`/magi:review` reviews pull requests with the configured reviewer agents and posts the result to GitHub.

It skips reviewer accounts that already reviewed the current effective head. If a reviewer reviewed an older effective head, Magi runs that reviewer in re-review mode. If every configured reviewer account already reviewed the current effective head, the command aborts instead of posting duplicate reviews.

## Flow

1. Fetch PR metadata with `gh pr view`.
2. Abort if the PR is a draft.
3. Stop before agent execution when `review.safety.requiredLabels`, `review.safety.blockedPaths`, `review.safety.maxChangedFiles`, or `review.safety.allowAuthors` blocks the PR.
4. Fetch existing PR reviews for configured `review.agents[].account` values.
5. Determine review freshness against the latest non-merge PR commit.
6. Skip current reviewers, use re-review mode for stale reviewers, and use initial review mode for reviewers with no prior review.
7. Wait for PR checks when `review.checks.wait` is enabled.
8. If checks fail, remove checks matching `review.checks.exclude`, fetch failed job logs, classify each remaining failure as `SCOPE_IN` or `SCOPE_OUT`, rerun only `SCOPE_OUT` GitHub Actions jobs up to `review.checks.retryFailedJobs`, and pass `SCOPE_IN` failure context to reviewers. Dry runs skip the rerun and report it as a planned action.
9. Create a detached git worktree under `review.worktree` and check out the PR branch.
10. Run each non-skipped reviewer agent through the reviewer worker pool.
11. Parse each reviewer response as the fixed review or re-review JSON schema.
12. Validate each `CHANGES_REQUESTED` finding by asking the other reviewers to vote on it.
13. Keep only findings that reach finding-level majority.
14. Reconsider any minority `CLOSE` verdict before posting.
15. Aggregate active reviewer verdicts plus skipped reviewer verdicts from existing GitHub review state by majority vote.
16. Post each active reviewer result to GitHub with that reviewer's configured account, unless `--dry-run` is set.
17. If configured, merge or close the PR according to `review.automation`.
18. Remove the temporary worktree and recorded worktree branch.

Reviewer verdicts map to GitHub actions:

| Verdict             | GitHub action                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `MERGE`             | Post an approving PR review.                                                                                      |
| `CHANGES_REQUESTED` | Post a request-changes PR review with every finding as an inline review comment.                                  |
| `CLOSE`             | Post a PR comment with `reason`. The review command closes the PR only when `review.automation.close` is enabled. |

The majority result can be `MERGE`, `CHANGES_REQUESTED`, or `CLOSE`. Reviewer count must be odd and at least 3, so one verdict must reach majority.

## Outputs

Magi posts GitHub reviews and comments from each active reviewer account.

Review artifacts are written to the run output directory:

| File                                 | Contents                                       |
| ------------------------------------ | ---------------------------------------------- |
| `{reviewer}.review.prompt.txt`       | Final prompt sent to the reviewer model.       |
| `{reviewer}.review.raw.txt`          | Raw model output after any repair attempts.    |
| `{reviewer}.review.json`             | Parsed review JSON.                            |
| `{reviewer}.finding-validation.json` | Parsed finding validation votes.               |
| `finding-validation.json`            | Kept and discarded findings after voting.      |
| `majority.json`                      | Majority counts, reviewers, threshold, result. |
| `sessions.json`                      | OpenCode session ID per reviewer.              |
| `posted.json`                        | GitHub posting result per reviewer.            |

## Configuration

Important settings for `/magi:review`:

| Setting                               | Purpose                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `review.agents`                       | Reviewer agents, models, personas, permissions, and accounts. |
| `review.checks.wait`                  | Wait for PR checks before review.                             |
| `review.checks.exclude`               | Ignore matching failed checks.                                |
| `review.checks.retryFailedJobs`       | Retry scope-outside GitHub Actions jobs.                      |
| `review.concurrency.reviewers`        | Maximum reviewer agents running at once.                      |
| `review.concurrency.runs`             | Maximum PR runs processed at once.                            |
| `github.apiRetryAttempts`             | Retry count for GitHub CLI API rate limit errors.             |
| `review.output`                       | PR run output directory.                                      |
| `output.repairAttempts`               | Model output repair attempts.                                 |
| `review.prompts.review`               | Initial review prompt template.                               |
| `review.prompts.rereview`             | Re-review prompt template.                                    |
| `review.prompts.reviewGuidelines`     | Shared review guidance file.                                  |
| `review.prompts.ciClassification`     | Failed-check classification prompt template.                  |
| `review.prompts.findingValidation`    | Finding validation prompt template.                           |
| `review.prompts.closeReconsideration` | Close reconsideration prompt template.                        |
| `review.safety.requiredLabels`        | Required PR labels before review.                             |
| `review.safety.blockedPaths`          | Changed-file glob patterns that block review.                 |
| `review.safety.maxChangedFiles`       | Maximum changed file count before review is blocked.          |
| `review.safety.allowAuthors`          | Allowed PR authors when configured.                           |
| `review.worktree`                     | Temporary PR worktree base directory.                         |

See [Config](/docs/config.md) for the complete configuration reference.

## FAQ

### What happens if a reviewer already reviewed the PR?

Magi reuses that review when it is current for the latest non-merge PR commit. If only some reviewers are current, Magi reruns the stale or missing reviewers and combines their new verdicts with the skipped reviewers' existing GitHub review states.

### What happens on a draft PR?

Magi aborts before running reviewers or posting results.

### How does re-review mode choose the diff?

Each reviewer receives the diff from that reviewer's previous review commit to the current PR head. If Magi cannot reuse the original OpenCode session, it includes that reviewer's previous GitHub review body and metadata in the re-review prompt.

### How are review findings filtered?

Each `CHANGES_REQUESTED` finding is validated by the other reviewers. The finding author counts as one approval; with three reviewers, at least one of the other two reviewers must agree for the finding to remain.

Every finding must target a valid right-side line in the PR diff. If the problem does not have an exact changed line, reviewers anchor it to the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior, such as missing validation, wiring, requirements, tests, documentation, configuration, or a relevant call site.

### What GitHub data windows are fetched?

Magi currently queries reviews first 100, commits first 100, review threads first 100, and comments first 50 per thread. Very large PRs can miss older data when determining review freshness or unresolved thread state.

### Which GitHub accounts are used?

Each reviewer posts with its configured `review.agents[].account`. Each account must be authenticated with GitHub CLI and able to read the repository and post PR reviews or comments. Review automation uses the first configured reviewer account for PR merge or close actions.
