Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:

```json
{
  "mode": "EDITED" | "REPLIED",
  "commitSha": "full sha, required only when mode is EDITED; omit when mode is REPLIED",
  "commitMessage": "fix(scope): short description, required only when mode is EDITED; omit when mode is REPLIED",
  "filesTouched": ["relative/path.ext"],
  "pullRequest": {
    "title": "PR title, required only when mode is EDITED; omit when mode is REPLIED",
    "body": "PR body, required only when mode is EDITED; omit when mode is REPLIED"
  },
  "responses": [{ "commentId": 123, "action": "FIXED" | "DISAGREE" | "ASK", "body": "Fixed." }]
}
```

Rules:

- Use EDITED only when you edited files, staged changes, and committed.
- Use REPLIED when you only replied without code changes.
- For EDITED, pullRequest.title and pullRequest.body must be non-empty and follow the repository's PR conventions.
- Do not push or create the PR. The orchestrator pushes and creates the PR using pullRequest exactly as provided.
- filesTouched is required for EDITED and must include every final changed file.
- responses may be omitted when no review threads were addressed.
- REPLIED may omit filesTouched. If present, it must be empty.
- REPLIED requires at least one DISAGREE or ASK response.
