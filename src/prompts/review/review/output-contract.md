Return exactly one JSON object and nothing else. Do not wrap it in markdown.

```json
{
  "verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE",
  "findings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }],
  "reason": "Required only for CLOSE."
}
```

Rules:

- `"verdict"` must be `"MERGE"`, `"CHANGES_REQUESTED"`, or `"CLOSE"`.
- `"MERGE"` requires an empty `"findings"` array.
- `"CHANGES_REQUESTED"` requires at least one `"finding"`.
- `"CLOSE"` requires `"reason"` and an empty `"findings"` array.
- `"path"` must be repository-relative.
- `"line"` is required and must target a valid right-side line inside the PR diff hunk.
- `"startLine"` is optional and must also target a valid right-side line inside the same PR diff hunk range.
- Omit `"startLine"` for single-line findings.
- Do not omit `"line"`. Do not create file-level or body-only findings.
- Missing closing-issue requirements must be normal findings anchored to the nearest responsible changed line.
- If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
