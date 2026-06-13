Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:

```json
{
  "vote": "YES" | "NO" | "INVALID" | "ASK",
  "reason": "Short rationale.",
  "body": "Required only when vote is ASK. Public issue comment body asking for the missing information."
}
```

Rules:

- body is required when vote is ASK and must be written for the issue author.
- Omit body when vote is not ASK.
