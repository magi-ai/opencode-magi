Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:

```json
{
  "vote": "DUPLICATE" | "NOT_DUPLICATE",
  "duplicateOf": 123,
  "reason": "Short rationale."
}
```

Rules:

- duplicateOf is required only when vote is DUPLICATE.
- duplicateOf must be one of the provided duplicate candidate issue numbers.
