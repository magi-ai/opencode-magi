Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:

```json
{
  "signals": [
    {
      "id": "configured_signal_id",
      "reason": "Short rationale."
    }
  ]
}
```

Rules:

- Return only configured signal IDs that apply.
- Omit `"signals"` when none apply.
