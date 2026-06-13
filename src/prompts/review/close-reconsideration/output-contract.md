Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:

```json
{
  "verdict": "MERGE" | "CHANGES_REQUESTED",
  "findings": [
    {
      "path": "relative/path.ext",
      "line": 123,
      "startLine": 120,
      "issue": "What is wrong.",
      "fix": "How to fix it."
    }
  ]
}
```

Rules:

- MERGE requires an empty findings array.
- CHANGES_REQUESTED requires at least one finding.
- CLOSE is not allowed in this reconsideration step.
- line is required and must target a valid right-side line inside the PR diff hunk.
- startLine is optional and must also target a valid right-side line inside the same PR diff hunk range.
- Do not omit line. Do not create file-level or body-only findings.
