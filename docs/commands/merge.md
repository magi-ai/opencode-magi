# /magi:merge

## Usage

```txt
/magi:merge <PR...>
/magi:merge --dry-run <PR...>
```

`<PR...>` accepts one or more PR numbers or PR URLs separated by spaces or commas.

Use `--dry-run` to run review, editor, re-review, majority voting, and reporting without posting to GitHub, pushing editor commits, resolving threads, merging, closing, or rerunning CI jobs. The editor may still modify and commit inside Magi's temporary worktree so reviewers can inspect the local diff.

## What It Does

`/magi:merge` runs the review flow first, then closes, merges, or asks the editor agent to respond to requested changes.

During a single merge flow, Magi reuses reviewer OpenCode sessions from the initial review when asking the same reviewers to re-review editor changes or replies. This keeps reviewer conversations continuous while still writing session IDs to artifacts for auditability.

## Flow

1. Stop before agent execution when `safety.*` gates block the PR.
2. Run the full [`/magi:review`](review.md) flow.
3. If every configured reviewer already reviewed the current effective head, reuse those existing verdicts instead of aborting.
4. If the review decision is `CLOSE`, close the PR when `automation.close` is enabled and stop. Dry runs stop before closing.
5. If the review decision is `MERGE`, merge the PR when `automation.merge` is enabled and stop. Dry runs stop before merging.
6. If the review majority is `CHANGES_REQUESTED`, start edit and re-review cycles.
7. Fetch unresolved review threads, or use synthetic dry-run threads from reviewer findings.
8. Run the editor agent with the edit prompt.
9. Parse editor output as the fixed edit JSON schema.
10. Push the editor commit to the PR branch with the editor account when the editor made code changes, unless `--dry-run` is set.
11. Post editor replies to the review comments listed in the editor output, unless `--dry-run` is set.
12. Wait for PR checks again when the editor made code changes and `checks.waitAfterEdit` is enabled. Dry runs skip post-edit CI because changes are not pushed.
13. Classify failed job logs as `SCOPE_IN` or `SCOPE_OUT`; rerun only `SCOPE_OUT` GitHub Actions jobs and pass `SCOPE_IN` failure context to re-reviewers.
14. Fetch each reviewer's unresolved threads, or use synthetic dry-run threads from reviewer findings.
15. Run every reviewer agent with the re-review prompt.
16. Parse each re-review response as the fixed re-review JSON schema.
17. Resolve threads, post follow-up replies, post new findings, post close comments, or approve according to each reviewer output, unless `--dry-run` is set.
18. Aggregate re-review verdicts and apply `merge.approvalPolicy`.
19. If the re-review decision is `MERGE`, merge the PR when `automation.merge` is enabled and stop. Dry runs stop before merging.
20. If the re-review decision is `CLOSE`, close the PR when `automation.close` is enabled and stop. Dry runs stop before closing.
21. Repeat while at least one unresolved review thread still has remaining resolution attempts.
22. If only exhausted unresolved threads remain, return `changes_unresolved` and leave the PR open.
23. Remove the temporary worktree when the merge flow completes.

Merge outcomes:

| Status               | Meaning                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `merged`             | The PR reached `MERGE` and `gh pr merge` completed successfully.                                                     |
| `approved`           | The PR reached `MERGE`, approvals were posted, and `automation.merge` disabled the merge step.                       |
| `closed`             | A review or re-review majority was `CLOSE` and Magi ran `gh pr close`.                                               |
| `close_requested`    | A review or re-review decision was `CLOSE`, comments were posted, and `automation.close` disabled the close step.    |
| `dequeued`           | With `merge.mergeQueue: true`, GitHub removed the PR from auto-merge or the merge queue.                             |
| `changes_unresolved` | Unresolved review threads reached the per-thread `merge.maxThreadResolutionCycles` limit without a `MERGE` majority. |
| `ci_unresolved`      | Review and approvals completed, but scope-outside CI remained unresolved so Magi did not merge.                      |

## Outputs

Magi may post reviews, comments, editor replies, approvals, close comments, and resolved review threads. It may also push editor commits, close the PR, or merge the PR depending on the final decision and automation settings.

Merge artifacts are written to the run output directory:

| File                                           | Contents                                     |
| ---------------------------------------------- | -------------------------------------------- |
| `editor.cycle-{cycle}.prompt.txt`              | Final prompt sent to the editor model.       |
| `editor.cycle-{cycle}.raw.txt`                 | Raw editor model output.                     |
| `editor.cycle-{cycle}.json`                    | Parsed editor JSON.                          |
| `{reviewer}.rereview.cycle-{cycle}.prompt.txt` | Final re-review prompt sent to the reviewer. |
| `{reviewer}.rereview.cycle-{cycle}.raw.txt`    | Raw re-review model output.                  |
| `{reviewer}.rereview.cycle-{cycle}.json`       | Parsed re-review JSON.                       |
| `rereview-majority.cycle-{cycle}.json`         | Re-review majority counts and result.        |

The merge flow also writes the review artifacts listed in [`/magi:review`](review.md).

## Configuration

Important settings for `/magi:merge`:

| Setting                           | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `agents.editor`                   | Editor agent, model, persona, permissions, GitHub account, author. |
| `agents.reviewers`                | Reviewer agents used for initial review and re-review.             |
| `automation.close`                | Run `gh pr close` after a close decision.                          |
| `automation.merge`                | Run `gh pr merge` after approval.                                  |
| `checks.waitAfterEdit`            | Wait for PR checks after editor changes.                           |
| `merge.approvalPolicy`            | Decide readiness by `majority` or `unanimous`.                     |
| `merge.auto`                      | Pass `--auto` to `gh pr merge`.                                    |
| `merge.deleteBranch`              | Delete the PR branch during merge when configured.                 |
| `merge.maxThreadResolutionCycles` | Maximum fix/reply attempts per unresolved review thread.           |
| `merge.mergeQueue`                | Poll GitHub merge queue completion after `gh pr merge`.            |
| `merge.method`                    | Merge method: `merge`, `squash`, or `rebase`.                      |
| `prompts.edit*`                   | Editor prompt templates and guidelines.                            |
| `prompts.rereview*`               | Re-review prompt templates and guidelines.                         |
| `safety.*`                        | Optional gates that block merge before agents run.                 |

See [Config](/docs/config.md) for the complete configuration reference.

## FAQ

### What happens when `automation.merge` is false?

Magi posts approvals and stops with `approved`. It does not run `gh pr merge`.

### What happens when `automation.close` is false?

Magi posts close comments and stops with `close_requested`. It leaves the PR open.

### How does merge queue support work?

`merge.auto` controls whether Magi passes `--auto` to `gh pr merge`. `merge.mergeQueue` controls whether Magi polls GitHub after the merge command to wait for merge queue completion. These settings are independent.

When `merge.mergeQueue` is `true`, Magi also checks the base branch rules for a `merge_queue` rule. If GitHub reports that merge queue is not enabled, or Magi cannot verify it, the run records a warning.

### What does `merge.approvalPolicy: unanimous` change?

`MERGE` requires every reviewer to approve. A `CLOSE` majority still closes or requests close. A close minority is sent back to the close reviewer for reconsideration; if any reviewer remains non-approving after reconsideration, Magi continues as `CHANGES_REQUESTED`.

### How many resolution cycles can run?

`merge.maxThreadResolutionCycles` limits fix, disagreement, and clarification attempts per unresolved review thread. The default is `5`. Set it to `0` to allow unlimited attempts until the PR reaches `MERGE`, `CLOSE`, `ci_unresolved`, the command is cancelled, or the run fails.

### Does CI failure block review or editing?

Scope-outside unresolved jobs do not stop review, editing, re-review, or approval posting. They do stop the final merge and return `ci_unresolved`.

### Which GitHub account pushes and merges?

The editor account configured at `agents.editor.account` posts fixes, pushes commits, closes PRs, and merges PRs. It must be authenticated with GitHub CLI and able to push to the repository.

### Can child agents request permissions?

Yes. Magi records pending child-agent permission and tool questions in run state and notifies the parent session. The parent can answer or reject them with `magi_permission_reply`, `magi_question_reply`, or `magi_question_reject`.
