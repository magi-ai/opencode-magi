# Edit

Used when the editor responds to requested changes by fixing code, disagreeing with a clear reason, or asking for clarification.

Config key: `merge.prompts.edit`

Built-in template: [`merge/edit.md`](/src/prompts/templates/merge/edit.md)

| Placeholder           | Meaning                                 |
| --------------------- | --------------------------------------- |
| `{pr}`                | Pull request number.                    |
| `{owner}` / `{repo}`  | GitHub repository owner and name.       |
| `{reviewFindings}`    | Blocking review findings to address.    |
| `{worktreePath}`      | Temporary PR worktree path.             |
| `{unresolvedThreads}` | JSON list of unresolved review threads. |
