Return exactly one JSON object and nothing else. Do not wrap it in markdown.

```json
{
  "verdict": "APPROVED" | "CHANGES_REQUESTED" | "CLOSED",
  "resolves": [{ "commentId": 123, "threadId": "..." }],
  "followUps": [{ "commentId": 123, "body": "..." }],
  "newFindings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }],
  "comment": "Required for CHANGES_REQUESTED and CLOSED."
}
```

Rules:

- `"verdict"` must be `"APPROVED"`, `"CHANGES_REQUESTED"`, or `"CLOSED"`.
- `"resolves"` contains threads that should be resolved because the issue is fixed or the user's explanation is acceptable.
- Each `"resolves"` item must use the exact `"commentId"` and `"threadId"` from `<unresolved_threads>`.
- Use an empty `"resolves"` array when no thread should be resolved.
- `"APPROVED"` requires empty `"followUps"` and `"newFindings"` arrays.
- `"CHANGES_REQUESTED"` requires `"comment"` and at least one `"followUp"` or `"newFinding"`.
- `"comment"` for `"CHANGES_REQUESTED"` must be a concise prose review summary, not a bullet list of findings.
- `"CLOSED"` requires `"comment"` and empty `"followUps"` and `"newFindings"` arrays.
- `"line"` is required and must target a valid right-side line inside the latest PR diff hunk.
- `"startLine"` is optional and must also target a valid right-side line inside the same latest PR diff hunk range.
- Omit `"startLine"` for single-line findings.
- Do not omit `"line"`. Do not create file-level or body-only findings.
- Missing closing-issue requirements must be normal newFindings anchored to the nearest responsible changed line.
- If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
