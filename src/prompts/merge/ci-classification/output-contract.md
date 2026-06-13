Return exactly one JSON object and nothing else. Do not wrap it in markdown.

```json
{
  "checks": [
    {
      "name": "exact failed check name",
      "classification": "SCOPE_IN" | "SCOPE_OUT",
      "reason": "Short reason."
    }
  ]
}
```

Rules:

- Return one item for every failed check.
- SCOPE_IN means the failure should be treated as caused by the PR changes or the editor changes and passed to reviewers/editor.
- SCOPE_OUT means the failure is likely flaky, external, or infrastructure-related and may be rerun.
- If uncertain, choose SCOPE_IN.
