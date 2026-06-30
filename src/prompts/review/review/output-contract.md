Return exactly one JSON object and nothing else. Do not wrap it in markdown.

```json
{
  "verdict": "APPROVED" | "CHANGES_REQUESTED" | "CLOSED",
  "findings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }],
  "comment": "Required for CHANGES_REQUESTED and CLOSED."
}
```

Rules:

- `"verdict"` must be `"APPROVED"`, `"CHANGES_REQUESTED"`, or `"CLOSED"`.
- `"APPROVED"` may omit `"findings"`. If present, it must be empty.
- `"APPROVED"` may omit `"comment"`. If present, it must be an empty string.
- `"CHANGES_REQUESTED"` requires `"comment"` and at least one `"finding"`.
- `"comment"` for `"CHANGES_REQUESTED"` must be a concise prose review summary, not a bullet list of findings.
- `"CLOSED"` requires `"comment"` and may omit `"findings"`. If present, `"findings"` must be empty.
- `"path"` must be repository-relative.
- `"line"` is required and must target a valid right-side line inside the PR diff hunk.
- `"startLine"` is optional and must also target a valid right-side line inside the same PR diff hunk range.
- Omit `"startLine"` for single-line findings.
- Do not omit `"line"`. Do not create file-level or body-only findings.
- Missing closing-issue requirements must be normal findings anchored to the nearest responsible changed line.
- If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
