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
