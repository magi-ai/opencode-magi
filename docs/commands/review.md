# Review

## Usage

```txt
/magi:review <PR...>
/magi:review --dry-run <PR...>
/magi:review --sync <PR...>
/magi:review --no-merge --run-concurrency 1 <PR...>
```

`<PR...>` accepts one or more PR numbers or PR URLs separated by spaces or commas.

Use `--dry-run` to run CI classification, reviewer agents, majority voting, and reporting without posting GitHub reviews or comments. Scope-out CI jobs are classified, but reruns are reported as planned actions instead of being triggered.

Use `--sync` to wait for the review run to complete before returning the command output.

Per-run flags override merged config before validation and resolution. If both positive and negative boolean flags are supplied, the later flag wins. `--dry-run` remains the strongest safety mode and prevents GitHub mutations even when automation-enabling flags are supplied.

Review flags:

| Flag                                | Effect or override                                     |
| ----------------------------------- | ------------------------------------------------------ |
| `--dry-run`                         | Prevents GitHub mutations and CI reruns.               |
| `--sync`                            | Waits for the review run to complete before returning. |
| `--language <value>`                | `language`                                             |
| `--merge`, `--no-merge`             | `review.automation.merge`                              |
| `--close`, `--no-close`             | `review.automation.close`                              |
| `--retry-failed-jobs <n>`           | `review.checks.retryFailedJobs`                        |
| `--reviewer-concurrency <n>`        | `review.concurrency.reviewers`                         |
| `--run-concurrency <n>`             | `review.concurrency.runs`                              |
| `--wait-checks`, `--no-wait-checks` | `review.checks.wait`                                   |

## What It Does

`/magi:review` reviews pull requests with the configured reviewer agents and posts the result to GitHub.

It skips reviewer accounts that already reviewed the current effective head. If a reviewer reviewed an older effective head, Magi runs that reviewer in re-review mode. If every configured reviewer account already reviewed the current effective head, the command aborts instead of posting duplicate reviews.

## Flow

1. Fetch PR metadata with `gh pr view`.
2. Abort if the PR is a draft.
3. Stop before agent execution when `review.safety.requiredLabels`, `review.safety.blockedPaths`, `review.safety.maxChangedFiles`, or `review.safety.allowAuthors` blocks the PR.
4. Fetch existing PR reviews for configured `review.reviewers[].account` values.
5. Determine review freshness against the latest non-merge PR commit.
6. Skip current reviewers, use re-review mode for stale reviewers, and use initial review mode for reviewers with no prior review.
7. Fetch and write review context for the PR, related issues, PR comments, and review discussion.
8. Wait for required PR checks when `review.checks.wait` is enabled. Optional checks are ignored for review gating.
9. If checks fail, remove checks matching `review.checks.exclude`, fetch failed job logs, classify each remaining failure as `SCOPE_IN` or `SCOPE_OUT`, rerun only `SCOPE_OUT` GitHub Actions jobs up to `review.checks.retryFailedJobs`, and pass `SCOPE_IN` failure context to reviewers. Dry runs skip the rerun and report it as a planned action.
10. Create a detached git worktree under `review.worktree` and check out the PR branch.
11. Detect merge conflicts between the PR head and base branch and pass conflicted files plus right-side PR diff line hints to reviewers when conflicts exist.
12. Run each non-skipped reviewer agent through the reviewer worker pool.
13. Parse each reviewer response as the fixed review or re-review JSON schema.
14. Validate each `CHANGES_REQUESTED` finding by asking the other reviewers to vote on it.
15. Keep only findings that reach finding-level majority.
16. Reconsider any minority `CLOSE` verdict before posting.
17. Aggregate active reviewer verdicts plus skipped reviewer verdicts from existing GitHub review state by majority vote.
18. Post each active reviewer result to GitHub with that reviewer's configured account, unless `--dry-run` is set.
19. If configured, merge or close the PR according to `review.automation`.
20. Remove the temporary worktree and recorded worktree branch.

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

| File                                          | Contents                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `review-context.json`                         | Structured PR, related issue, PR comment, and review discussion context. |
| `review-context.md`                           | Rendered review context passed to reviewer prompts.                      |
| `{reviewer}.ci-classification.prompt.txt`     | Final failed-check classification prompt.                                |
| `{reviewer}.ci-classification.raw.txt`        | Raw failed-check classification output.                                  |
| `{reviewer}.review.prompt.txt`                | Final initial review prompt sent to the reviewer model.                  |
| `{reviewer}.review.raw.txt`                   | Raw initial review model output after any repair attempts.               |
| `{reviewer}.review.json`                      | Parsed initial review JSON.                                              |
| `{reviewer}.rereview.prompt.txt`              | Final re-review prompt for stale reviewers.                              |
| `{reviewer}.rereview.raw.txt`                 | Raw re-review model output after any repair attempts.                    |
| `{reviewer}.rereview.json`                    | Parsed re-review JSON.                                                   |
| `{reviewer}.finding-validation.prompt.txt`    | Final prompt for validating another reviewer's findings.                 |
| `{reviewer}.finding-validation.raw.txt`       | Raw finding validation output.                                           |
| `{reviewer}.finding-validation.json`          | Parsed finding validation votes.                                         |
| `finding-validation.json`                     | Validation votes plus kept and discarded findings after voting.          |
| `{reviewer}.close-reconsideration.prompt.txt` | Final prompt for reconsidering a minority `CLOSE` verdict.               |
| `{reviewer}.close-reconsideration.raw.txt`    | Raw close reconsideration output.                                        |
| `{reviewer}.close-reconsideration.json`       | Parsed close reconsideration JSON.                                       |
| `majority.json`                               | `approvalPolicy`, final `verdict`, and reviewer `verdicts`.              |
| `sessions.json`                               | OpenCode session ID per reviewer.                                        |
| `posted.json`                                 | GitHub posting, dry-run, skip, and automation result per reviewer.       |
| `report.md`                                   | Human-readable run report.                                               |

## Configuration

Important settings for `/magi:review`:

| Setting                               | Purpose                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `review.reviewers`                    | Reviewer agents, models, personas, permissions, and accounts. |
| `review.checks.wait`                  | Wait for required PR checks before review.                    |
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

### Do optional checks block review?

No. `review.checks.wait` waits only for required PR checks. Optional pending checks do not gate review or failed-check classification.

### How does re-review mode choose the diff?

Each reviewer receives the diff from that reviewer's previous review commit to the current PR head. If Magi cannot reuse the original OpenCode session, it includes that reviewer's previous GitHub review body and metadata in the re-review prompt.

### How are review findings filtered?

Each `CHANGES_REQUESTED` finding is validated by the other reviewers. The finding author counts as one approval; with three reviewers, at least one of the other two reviewers must agree for the finding to remain.

Every finding must target a valid right-side line in the PR diff. If the problem does not have an exact changed line, reviewers anchor it to the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior, such as missing validation, wiring, requirements, tests, documentation, configuration, or a relevant call site.

When the PR conflicts with the base branch, reviewer prompts include `<merge_conflict_context>` with conflicted files, merge-tree excerpts, and `suggestedLine` values when a valid right-side PR diff line is available. Reviewers should request changes for unresolved conflicts that make the PR unsafe or impossible to merge.

### What GitHub data windows are fetched?

Magi currently uses different windows for freshness, review context, and unresolved thread checks:

| Purpose                  | Window                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Review freshness         | Reviews first 100 and commits first 100.                                                                                                        |
| Review context           | PR comments last 20, review threads last 50, review thread comments last 20, closing issue comments last 20, referenced issue comments last 10. |
| Unresolved thread checks | Review threads first 100 and comments first 50 per thread, filtered to unresolved threads and, for re-review, the target reviewer.              |

Review context comment bodies are truncated after 4000 characters. Very large PRs can miss older data when determining review freshness, building review context, or checking unresolved thread state.

### Which GitHub accounts are used?

Each reviewer posts with its configured `review.reviewers[].account`. Each account must be authenticated with GitHub CLI and able to read the repository and post PR reviews or comments. Review automation uses the first configured reviewer account for PR merge or close actions.
