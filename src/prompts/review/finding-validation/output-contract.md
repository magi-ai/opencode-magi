Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:

```json
{
  "votes": [
    {
      "reviewer": "reviewer-key-that-authored-the-finding",
      "findingIndex": 0,
      "vote": "AGREE" | "DISAGREE",
      "reason": "Optional short rationale."
    }
  ]
}
```

Rules:

- Vote on every finding listed in the task.
- Do not vote on your own findings.
- AGREE means the finding should remain posted.
- DISAGREE means the finding should be discarded.
