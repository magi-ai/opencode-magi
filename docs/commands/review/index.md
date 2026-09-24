<p align='center'>
  English | <a href='index.ja.md'>日本語</a>
</p>

# `magi:review`

Runs pull request reviews and posts the review results.

## Usage

Run the following command in OpenCode.

```txt
/magi:review 123
/magi:review 123 124
/magi:review 123 --dry-run
```

## Arguments

| Argument | Required | Description                                                                                                         |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `prs`    | Yes      | Pull request numbers or pull request URLs to review. You can specify multiple values separated by spaces or commas. |

## Options

| Option                               | Description                                       |
| ------------------------------------ | ------------------------------------------------- |
| `--dry-run`                          | Runs without posting review results.              |
| `--retry-api-attempts <count>`       | Overrides the API retry count.                    |
| `--language <language>`              | Overrides the output language for the run.        |
| `--merge` / `--no-merge`             | Overrides automatic merge after review.           |
| `--close` / `--no-close`             | Overrides close automation.                       |
| `--retry-failed-jobs <count>`        | Overrides how many times failed jobs are retried. |
| `--concurrency-reviewers <count>`    | Overrides reviewer concurrency.                   |
| `--concurrency-runs <count>`         | Overrides pull request run concurrency.           |
| `--wait-checks` / `--no-wait-checks` | Overrides whether to wait for checks to complete. |

## Flow

1. Validate the configuration. If validation fails, exit the command.
2. Validate the PR. If any of the following conditions apply, proceed to step 12.

- The PR is closed or already merged.
- The PR is a draft.
- The PR does not meet the conditions in the `review.safety` configuration.
- The PR author is the account used for reviews.

3. Check existing reviews. If there are no new changes or replies after a review, skip that reviewer's review and use their existing decision. If all reviewers are skipped, skip steps 5 through 8 and 10.
4. Inspect the checks.
5. Reviewers determine whether check failures are caused by the PR's changes. Rerun checks whose failures are not caused by the PR's changes.
6. Reviewers who are not skipped review or re-review the PR. Each reviewer decides to approve, request changes, or close.
7. Reviewers validate findings from reviewers who requested changes and accept findings supported by a majority. If none of a reviewer's findings are accepted, treat that reviewer's decision as approval.
8. If `review.merge.approvalPolicy` is set to `"unanimous"` and reviewers who decided to close are in the minority, have those reviewers reconsider and choose either approval or a change request. If they request changes, validate their findings as in step 7.
9. Aggregate the reviewers' decisions to determine the command's decision.
10. Post reviews to the PR.
11. Merge or close the PR. Do not perform the respective action if any of the following conditions apply.

- Merge
  - The command's decision is not approval.
  - The conditions in the `review.automation.merge` configuration are not met.
  - There are conflicts.
  - Checks have failed or are pending.
- Close
  - The command's decision is not to close.
  - The conditions in the `review.automation.close` configuration are not met.

12. Return the execution results as a report.
