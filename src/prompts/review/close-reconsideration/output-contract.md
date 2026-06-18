Return exactly one JSON object and nothing else. Do not wrap it in markdown.

```json
{
  "verdict": "MERGE" | "CHANGES_REQUESTED",
  "findings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }],
  "comment": "Required only for CHANGES_REQUESTED."
}
```

Rules:

- `"verdict"` must be `"MERGE"` or `"CHANGES_REQUESTED"`.
- `"MERGE"` requires an empty `"findings"` array.
- `"CHANGES_REQUESTED"` requires `"comment"` and at least one `"finding"`.
- `"comment"` for `"CHANGES_REQUESTED"` must be a concise prose review summary, not a bullet list of findings.
- `"CLOSE"` is not allowed in this reconsideration step.
- `"line"` is required and must target a valid right-side line inside the PR diff hunk.
- `"startLine"` is optional and must also target a valid right-side line inside the same PR diff hunk range.
- Do not omit `"line"`. Do not create file-level or body-only findings.
