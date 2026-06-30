# Documentation Rules

Use plain filenames for same-directory links. Use relative paths without a leading `./` for links within the current directory tree. Use repository-root absolute paths when a link would otherwise need to traverse up with `../`.

For same-directory links, omit the `./` prefix. For example, write `[Commit Rules](commit.md)` instead of `[Commit Rules](./commit.md)`.

For links within the current directory tree, omit the leading `/`. For example, write `[Review](review/review.md)` instead of `[Review](/docs/prompts/review/review.md)`.

When a link would need to traverse up with `../`, use a repository-root absolute path instead. For example, write `[Pull Request Template](/.github/pull_request_template.md)` instead of `[Pull Request Template](../../.github/pull_request_template.md)`.

When writing Japanese documentation, prefer natural Japanese terms over English words when a common Japanese expression exists. Keep proper nouns, code identifiers, commands, file paths, API names, and quoted source text unchanged.

When writing Japanese documentation, do not insert spaces between Japanese text and adjacent ASCII words, numbers, or inline code spans. For example, write "PRは、オープンです" instead of "PR は、オープンです", and write "`name`を指定します。" instead of "`name` を指定します。".
