Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:

```json
{
  "comments": [
    {
      "commentId": 123,
      "classification": "OBJECTION" | "NEW_EVIDENCE" | "CLARIFICATION" | "ACKNOWLEDGEMENT" | "UNRELATED",
      "reason": "Short rationale."
    }
  ]
}
```
