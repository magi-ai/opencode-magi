# Merge

## Usage

```txt
/magi:merge <PR...>
/magi:merge --dry-run <PR...>
/magi:merge --sync <PR...>
/magi:merge --no-merge --max-cycles 1 <PR...>
```

`<PR...>` accepts one or more PR numbers or PR URLs separated by spaces or commas.

Use `--dry-run` to run review, editor, re-review, majority voting, and reporting without posting to GitHub, pushing editor commits, resolving threads, merging, closing, or rerunning CI jobs. The editor may still modify and commit inside Magi's temporary worktree so reviewers can inspect the local diff.

Use `--sync` to wait for the merge flow to complete and return the run report instead of only starting a background run.

Per-run flags override merged config before validation and resolution. If both positive and negative boolean flags are supplied, the later flag wins. `--dry-run` remains the strongest safety mode and prevents GitHub mutations even when automation-enabling flags are supplied.

Merge flags:

| Flag                                                      | Overrides                         |
| --------------------------------------------------------- | --------------------------------- |
| `--language <value>`                                      | `language`                        |
| `--merge`, `--no-merge`                                   | `merge.automation.merge`          |
| `--close`, `--no-close`                                   | `merge.automation.close`          |
| `--max-cycles <n>`                                        | `merge.maxThreadResolutionCycles` |
| `--retry-failed-jobs <n>`                                 | `review.checks.retryFailedJobs`   |
| `--reviewer-concurrency <n>`                              | `review.concurrency.reviewers`    |
| `--run-concurrency <n>`                                   | `review.concurrency.runs`         |
| `--sync`                                                  | Wait for completion               |
| `--wait-checks`, `--no-wait-checks`                       | `review.checks.wait`              |
| `--wait-checks-after-edit`, `--no-wait-checks-after-edit` | `merge.checks.wait`               |

## What It Does

`/magi:merge` runs the review flow first, then closes, merges, or asks the editor agent to respond to requested changes.

During a single merge flow, Magi reuses reviewer OpenCode sessions from the initial review when asking the same reviewers to re-review editor changes or replies. This keeps reviewer conversations continuous while still writing session IDs to artifacts for auditability.

Top-level `mode` applies to the review and re-review phases. In `single` mode, reviewer-originated posts, follow-up replies, and thread resolutions use top-level `account`, while editor replies, pushes, merge operations, and merge-flow PR close operations still use `merge.editor.account`.

## Flow

1. Stop before agent execution when `review.safety.requiredLabels`, `review.safety.blockedPaths`, `review.safety.maxChangedFiles`, or `review.safety.allowAuthors` blocks the PR.
2. Run the full [`/magi:review`](review.md) flow.
3. If every configured reviewer already reviewed the current effective head, reuse those existing verdicts instead of aborting.
4. If the review decision is `CLOSE`, close the PR when `merge.automation.close` is enabled and stop. Dry runs stop before closing.
5. If the review decision is `MERGE`, merge the PR when `merge.automation.merge` is enabled and stop. Dry runs stop before merging. When merge queue mode returns `dequeued` and `merge.automation.conflict` is enabled, Magi may run one conflict recovery attempt before stopping.
6. If the review majority is `CHANGES_REQUESTED`, start edit and re-review cycles.
7. Fetch unresolved review threads, or use synthetic dry-run threads from reviewer findings.
8. Run the editor agent with the edit prompt.
9. Parse editor output as the fixed edit JSON schema.
10. Push the editor commit to the PR branch with the editor account when the editor made code changes, unless `--dry-run` is set.
11. Post editor replies to the review comments listed in the editor output, unless `--dry-run` is set.
12. Wait for required PR checks again when the editor made code changes and `merge.checks.wait` is enabled. Optional checks are ignored for post-edit CI gating. Dry runs skip post-edit CI because changes are not pushed.
13. Classify failed job logs as `SCOPE_IN` or `SCOPE_OUT`; rerun only `SCOPE_OUT` GitHub Actions jobs and pass `SCOPE_IN` failure context to re-reviewers.
14. Fetch each reviewer's unresolved threads, or use synthetic dry-run threads from reviewer findings.
15. Run every reviewer agent with the re-review prompt.
16. Parse each re-review response as the fixed re-review JSON schema.
17. Resolve threads, post follow-up replies, post new findings, post close comments, or approve according to reviewer outputs, unless `--dry-run` is set. Single mode posts reviewer-originated re-review mutations through top-level `account` with logical reviewer attribution.
18. Aggregate re-review verdicts and apply `review.merge.approvalPolicy`.
19. If the re-review decision is `MERGE`, merge the PR when `merge.automation.merge` is enabled and stop. Dry runs stop before merging.
20. If the re-review decision is `CLOSE`, close the PR when `merge.automation.close` is enabled and stop. Dry runs stop before closing.
21. Repeat while at least one unresolved review thread still has remaining resolution attempts.
22. If only exhausted unresolved threads remain, return `changes_unresolved` and leave the PR open.
23. Remove the temporary worktree when the merge flow completes.

Merge outcomes:

| Status               | Meaning                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `merged`             | The PR reached `MERGE` and the merge completed successfully, including any pending auto-merge completion.               |
| `approved`           | The PR reached `MERGE`, approvals were posted, and `merge.automation.merge` disabled the merge step.                    |
| `closed`             | A review or re-review majority was `CLOSE` and Magi ran `gh pr close`.                                                  |
| `close_requested`    | A review or re-review decision was `CLOSE`, comments were posted, and `merge.automation.close` disabled the close step. |
| `dequeued`           | GitHub removed the PR from auto-merge or the merge queue before it merged.                                              |
| `safety_blocked`     | A merge safety gate blocked the PR before agent execution.                                                              |
| `changes_unresolved` | Unresolved review threads reached the per-thread `merge.maxThreadResolutionCycles` limit without a `MERGE` majority.    |
| `ci_unresolved`      | Review and approvals completed, but scope-outside CI remained unresolved so Magi did not merge.                         |

## Outputs

Magi may post reviews, comments, editor replies, approvals, close comments, and resolved review threads. It may also push editor commits, close the PR, or merge the PR depending on the final decision and automation settings.

Merge artifacts are written to the run output directory:

| File                                                        | Contents                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `editor.cycle-{cycle}.prompt.txt`                           | Final prompt sent to the editor model.                   |
| `editor.cycle-{cycle}.raw.txt`                              | Raw editor model output.                                 |
| `editor.cycle-{cycle}.json`                                 | Parsed editor JSON.                                      |
| `editor.conflict.prompt.txt`                                | Final merge conflict recovery prompt sent to the editor. |
| `editor.conflict.raw.txt`                                   | Raw conflict recovery editor model output.               |
| `editor.conflict.json`                                      | Parsed conflict recovery editor JSON.                    |
| `{reviewer}.close-reconsideration.cycle-{cycle}.prompt.txt` | Final close reconsideration prompt sent to the reviewer. |
| `{reviewer}.close-reconsideration.cycle-{cycle}.raw.txt`    | Raw close reconsideration model output.                  |
| `{reviewer}.close-reconsideration.cycle-{cycle}.json`       | Parsed close reconsideration JSON.                       |
| `{reviewer}.rereview.cycle-{cycle}.prompt.txt`              | Final re-review prompt sent to the reviewer.             |
| `{reviewer}.rereview.cycle-{cycle}.raw.txt`                 | Raw re-review model output.                              |
| `{reviewer}.rereview.cycle-{cycle}.json`                    | Parsed re-review JSON.                                   |
| `rereview-majority.cycle-{cycle}.json`                      | Re-review majority counts and result.                    |
| `report.md`                                                 | Final human-readable merge run report.                   |

The merge flow also writes the review artifacts listed in [`/magi:review`](review.md).

## Configuration

Important settings for `/magi:merge`:

| Setting                               | Purpose                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `merge.editor`                        | Editor agent, model, persona, permissions, GitHub account, author.                    |
| `mode`                                | `single` or `multi` GitHub posting identity mode for reviewers. Defaults to `single`. |
| `account`                             | Shared reviewer posting account for single mode.                                      |
| `review.reviewers`                    | Reviewer agents used for initial review and re-review.                                |
| `merge.automation.close`              | Run `gh pr close` after a close decision.                                             |
| `merge.automation.merge`              | Merge or enqueue the PR after approval.                                               |
| `merge.automation.conflict`           | Resolve one merge queue dequeue conflict with the editor.                             |
| `merge.checks.wait`                   | Wait for required PR checks after editor changes.                                     |
| `review.merge.approvalPolicy`         | Decide readiness by `majority` or `unanimous`.                                        |
| `review.merge.auto`                   | Pass `--auto` to `gh pr merge` outside merge queue mode.                              |
| `review.merge.deleteBranch`           | Delete the PR branch during non-queue merges when configured.                         |
| `merge.maxThreadResolutionCycles`     | Maximum fix/reply attempts per unresolved review thread.                              |
| `review.merge.queue`                  | Enqueue the PR through GitHub GraphQL and poll queue completion.                      |
| `review.merge.method`                 | Merge method: `merge`, `squash`, or `rebase`.                                         |
| `merge.prompts.edit`                  | Editor prompt template.                                                               |
| `merge.prompts.editGuidelines`        | Shared edit guidance file.                                                            |
| `merge.prompts.ciClassification`      | Post-edit failed-check classification prompt template.                                |
| `review.prompts.rereview`             | Re-review prompt template.                                                            |
| `review.prompts.closeReconsideration` | Close reconsideration prompt template used during re-review.                          |
| `review.safety.requiredLabels`        | Required PR labels before merge flow.                                                 |
| `review.safety.blockedPaths`          | Changed-file glob patterns that block merge flow.                                     |
| `review.safety.maxChangedFiles`       | Maximum changed file count before merge flow is blocked.                              |
| `review.safety.allowAuthors`          | Allowed PR authors when configured.                                                   |

See [Config](/docs/config.md) for the complete configuration reference.

## FAQ

### What happens when `merge.automation.merge` is false?

Magi posts approvals and stops with `approved`. It does not run `gh pr merge`.

Dry runs also stop with `approved` after a `MERGE` decision and skip merge mutations.

### What happens when `merge.automation.close` is false?

Magi posts close comments and stops with `close_requested`. It leaves the PR open.

Dry runs also stop with `close_requested` after a `CLOSE` decision and skip close mutations.

### How does merge queue support work?

When `review.merge.queue` is `false`, Magi uses `gh pr merge` and applies `review.merge.method`, `review.merge.auto`, and `review.merge.deleteBranch`.

When `review.merge.queue` is `true`, Magi does not use `gh pr merge`. It enqueues the PR with GitHub GraphQL `enqueuePullRequest` and polls GraphQL queue state until the PR is merged or removed from the queue. `review.merge.method`, `review.merge.auto`, and `review.merge.deleteBranch` are ignored in this mode; configure merge method and automatic head branch deletion in the repository merge queue and pull request settings instead.

When `review.merge.queue` is `true`, Magi also checks the base branch rules for a `merge_queue` rule. If GitHub reports that merge queue is not enabled, or Magi cannot verify it, the run records a warning.

### How does merge queue conflict recovery work?

`merge.automation.conflict` defaults to `false`. When set to `true`, it only applies after `/magi:merge` reaches `MERGE`, `merge.automation.merge` is enabled, `review.merge.queue` is enabled, and GitHub removes the PR from the queue before merging.

Magi fetches the latest base branch in the temporary PR worktree and attempts a no-commit merge. If there are conflict markers, the editor resolves them, commits locally, and Magi pushes the result, waits for configured post-edit checks, re-runs reviewer re-review, and re-enqueues when reviewers still approve.

Magi attempts this recovery at most once per `/magi:merge` run. If the PR is dequeued again after re-enqueue, the run returns `dequeued`. Dry runs do not attempt conflict recovery because merge queue enqueueing and pushes are skipped.

### What does `review.merge.approvalPolicy: unanimous` change?

`MERGE` requires every reviewer to approve. A `CLOSE` majority still closes or requests close. A close minority is sent back to the close reviewer for reconsideration; if any reviewer remains non-approving after reconsideration, Magi continues as `CHANGES_REQUESTED`.

### How many resolution cycles can run?

`merge.maxThreadResolutionCycles` limits fix, disagreement, and clarification attempts per unresolved review thread. The default is `5`. Set it to `0` to allow unlimited attempts until the PR reaches `MERGE`, `CLOSE`, `ci_unresolved`, the command is cancelled, or the run fails.

### Does CI failure block review or editing?

Scope-outside unresolved jobs do not stop review, editing, re-review, or approval posting. They do stop the final merge and return `ci_unresolved`.

Optional pending checks do not block post-edit CI gating. `merge.checks.wait` waits only for required PR checks before classifying post-edit failures.

### Which GitHub account pushes and merges?

The editor account configured at `merge.editor.account` posts fixes, pushes commits, closes PRs, and merges PRs. It must be authenticated with GitHub CLI and able to push to the repository.

In `single` mode, top-level `account` handles reviewer approvals, change requests, close comments, reviewer follow-up replies, and reviewer thread resolutions. This preserves Magi consensus but still counts as one GitHub account for branch protection approvals.

### Can child agents request permissions?

Yes. Magi records pending child-agent permission and tool questions in run state and notifies the parent session. The parent can answer or reject them with `magi_permission_reply`, `magi_question_reply`, or `magi_question_reject`.
