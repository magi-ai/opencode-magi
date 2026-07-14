<p align='center'>
  <a href='index.md'>English</a> | 日本語
</p>

# `magi:review`

PRのレビューを実行し、レビュー結果を投稿するコマンドです。

## 使い方

OpenCodeで次のコマンドを実行します。

```txt
/magi:review 123
/magi:review 123 124
/magi:review 123 --dry-run
```

## 引数

| 引数  | 必須 | 説明                                                                       |
| ----- | ---- | -------------------------------------------------------------------------- |
| `prs` | はい | レビューするPR番号またはPR URL。空白またはカンマ区切りで複数指定できます。 |

## オプション

| オプション                           | 説明                                       |
| ------------------------------------ | ------------------------------------------ |
| `--dry-run`                          | レビュー結果を投稿せずに実行します。       |
| `--retry-api-attempts <count>`       | APIリトライ回数を上書きします。            |
| `--language <language>`              | 実行時の出力言語を上書きします。           |
| `--merge` / `--no-merge`             | レビュー後の自動マージ設定を上書きします。 |
| `--close` / `--no-close`             | クローズ自動化の設定を上書きします。       |
| `--retry-failed-jobs <count>`        | 失敗したジョブの再実行回数を上書きします。 |
| `--concurrency-reviewers <count>`    | レビュアーの並列数を上書きします。         |
| `--concurrency-runs <count>`         | PR単位の並列実行数を上書きします。         |
| `--wait-checks` / `--no-wait-checks` | チェック完了を待つかどうかを上書きします。 |
