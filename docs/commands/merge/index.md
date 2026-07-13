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
