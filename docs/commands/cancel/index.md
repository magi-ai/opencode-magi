<p align='center'>
  English | <a href='index.ja.md'>日本語</a>
</p>

# `magi:cancel`

Cancels tasks running in the background. When no pull request or issue number is specified, it cancels all background runs in progress.

## Usage

Run the following command in OpenCode.

```txt
/magi:cancel
/magi:cancel 123
/magi:cancel 123 124
```

## Arguments

| Argument  | Required | Description                                                                                                                             |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `numbers` | No       | Pull request or issue numbers to cancel. You can specify multiple numbers. When omitted, all background runs in progress are cancelled. |
