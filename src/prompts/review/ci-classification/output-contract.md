Return exactly one JSON object and nothing else. Do not wrap it in markdown.

```json
{
  "checks": [
    {
      "id": "exact failed check ID",
      "classification": "SCOPE_IN" | "SCOPE_OUT",
      "reason": "Short reason."
    }
  ]
}
```

Rules:

- Return one item for every failed check.
- `"id"` is the ID of the failed check.
- `"SCOPE_IN"` means the failure should be treated as caused by the PR changes and passed to creator.
- `"SCOPE_OUT"` means the failure is likely flaky, external, or infrastructure-related and may be rerun.
- `"reason"` is a short reason for the classification.
