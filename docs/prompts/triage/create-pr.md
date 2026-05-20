# Create PR

Used when the triage creator agent implements an accepted issue and opens an implementation PR.

Config key: `triage.prompts.create`

Built-in template: [`triage/create-pr.md`](/src/prompts/templates/triage/create-pr.md)

| Placeholder          | Meaning                                                 |
| -------------------- | ------------------------------------------------------- |
| `{issue}`            | Issue number.                                           |
| `{owner}` / `{repo}` | GitHub repository owner and name.                       |
| `{worktreePath}`     | Temporary worktree path checked out for implementation. |
| `{context}`          | JSON context with issue metadata and triage decision.   |
