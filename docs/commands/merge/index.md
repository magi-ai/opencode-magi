<p align='center'>
  English | <a href='index.ja.md'>日本語</a>
</p>

# `magi:merge`

Runs pull request review, required fixes, re-review, and merge.

## Usage

Run the following command in OpenCode.

```txt
/magi:merge 123
/magi:merge 123 124
/magi:merge 123 --dry-run
```

## Arguments

| Argument | Required | Description                                                                                                                   |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `prs`    | Yes      | Pull request numbers or pull request URLs to review and merge. You can specify multiple values separated by spaces or commas. |

## Options

| Option                                                    | Description                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `--dry-run`                                               | Runs without posting review results, applying fixes, or merging. |
| `--retry-api-attempts <count>`                            | Overrides the API retry count.                                   |
| `--language <language>`                                   | Overrides the output language for the run.                       |
| `--merge`, `--no-merge`                                   | Overrides merge automation.                                      |
| `--close`, `--no-close`                                   | Overrides close automation.                                      |
| `--max-cycles <count>`                                    | Overrides the maximum number of fix and re-review cycles.        |
| `--retry-failed-jobs <count>`                             | Overrides how many times failed jobs are retried.                |
| `--concurrency-reviewers <count>`                         | Overrides reviewer concurrency.                                  |
| `--concurrency-runs <count>`                              | Overrides pull request run concurrency.                          |
| `--wait-checks`, `--no-wait-checks`                       | Overrides whether to wait for checks before review.              |
| `--wait-checks-after-edit`, `--no-wait-checks-after-edit` | Overrides whether to wait for checks after fixes.                |

## Flow

1. Validate the configuration. If validation fails, exit the command.
2. Validate the PR. If any of the following conditions apply, proceed to step 14.

- The PR is closed or already merged.
- The PR is a draft.
- The PR does not meet the conditions in the `review.safety` configuration.
- The PR author is the account used for reviews.

3. Check existing reviews on the PR. If there are no new changes or replies after a review, skip that reviewer's review and use their existing decision. If all reviewers are skipped, skip steps 5 through 8 and 10.
4. Inspect the PR's checks.
5. Reviewers determine whether failures in the PR's checks are caused by the PR's changes. Rerun checks whose failures are not caused by the PR's changes.
6. Reviewers who are not skipped review or re-review the PR. Each reviewer decides to approve, request changes, or close.
7. Reviewers validate findings from reviewers who requested changes and accept findings supported by a majority. If none of a reviewer's findings are accepted, treat that reviewer's decision as approval.
8. If `review.merge.approvalPolicy` is set to `"unanimous"` and reviewers who decided to close are in the minority, have those reviewers reconsider and choose either approval or a change request. If they request changes, validate their findings as in step 7.
9. Aggregate the reviewers' decisions to determine the command's decision.
10. Post reviews to the PR.
11. If the command's decision is a change request, apply fixes and re-review. Repeat while the decision remains a change request, up to `merge.maxThreadResolutionCycles`. If the decision is still a change request at the limit, proceed to step 14.
12. Merge or close the PR. Do not perform the respective action if any of the following conditions apply.

- Merge
  - The command's decision is not approval.
  - The conditions in the `merge.automation.merge` configuration are not met.
  - The PR has conflicts.
  - The PR's checks have failed or are pending.
- Close
  - The command's decision is not to close.
  - The conditions in the `merge.automation.close` configuration are not met.

13. If step 12 detects conflicts and the conditions in `merge.automation.conflict` are met, resolve the conflicts, commit, and push. Inspect checks and re-review as after fixes in step 11. If the decision is a change request, repeat fixes and re-review up to `merge.maxThreadResolutionCycles`. Count conflict resolution as the first cycle. If the decision is still a change request at the limit, proceed to step 14. Otherwise, retry merging or closing as in step 12.
14. Return the execution results as a report.
