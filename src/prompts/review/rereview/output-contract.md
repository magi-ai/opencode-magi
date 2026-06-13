Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:

```json
{
  "verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE",
  "resolve": [{ "commentId": 123, "threadId": "..." }],
  "followUps": [{ "commentId": 123, "body": "..." }],
  "newFindings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }],
  "reason": "Required only for CLOSE."
}
```

Rules:

- MERGE requires empty followUps and newFindings arrays.
- CHANGES_REQUESTED requires at least one followUp or newFinding.
- CLOSE requires a reason and empty followUps and newFindings arrays.
- line is required and must target a valid right-side line inside the latest PR diff hunk.
- startLine is optional and must also target a valid right-side line inside the same latest PR diff hunk range.
- Omit startLine for single-line findings.
- Do not omit line. Do not create file-level or body-only findings.
- Missing closing-issue requirements must be normal newFindings anchored to the nearest responsible changed line.
- If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
