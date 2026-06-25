Return exactly one JSON object and nothing else. Do not wrap it in markdown.

Resolve the conflicts, stage the resolved files, create the merge commit, then return this exact JSON object:

```json
{}
```

Rules:

- Do not push. The orchestrator pushes after validating this envelope.
- Do not include commit metadata, touched files, responses, explanation, or markdown.
