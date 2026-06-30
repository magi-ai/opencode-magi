Return exactly one JSON object and nothing else. Do not wrap it in markdown.

```json
{
  "mode": "EDITED" | "REPLIED",
  "commitSha": "full sha, required only when mode is EDITED; omit when mode is REPLIED",
  "commitMessage": "fix(scope): short description, required only when mode is EDITED; omit when mode is REPLIED",
  "filesTouched": ["relative/path.ext"],
  "responses": [{ "commentId": 123, "action": "FIXED" | "DISAGREE" | "ASK", "body": "Fixed." }]
}
```

Rules:

- Use `"EDITED"` only when you edited files, staged changes, and committed.
- Use `"REPLIED"` when you only replied without code changes.
- `"FIXED"` means you agreed with the reviewer and made a code change.
- `"DISAGREE"` means you did not edit because the requested change is incorrect or unnecessary.
- `"ASK"` means you need clarification and did not edit.
- Do not make changes just because a reviewer requested them; edit only when you understand and agree.
- Do not push. The orchestrator pushes after validating this envelope.
- `filesTouched` is required for `"EDITED"` and must include every final changed file.
- `responses` is required and must include a reply for each thread you addressed.
- `"EDITED"` requires at least one response.
- `"REPLIED"` may omit `filesTouched`. If present, it must be empty.
- `"REPLIED"` requires at least one `"DISAGREE"` or `"ASK"` response.
