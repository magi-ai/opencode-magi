Return exactly one JSON object and nothing else. Do not wrap it in markdown.

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

- `"votes"` must include one vote for every finding listed in the task.
- Do not vote on your own findings.
- `"reviewer"` is the reviewer key that authored the finding.
- `"findingIndex"` is the zero-based index of the finding in that reviewer's listed findings.
- `"vote"` must be `"AGREE"` or `"DISAGREE"`.
- `"AGREE"` means the finding should remain posted.
- `"DISAGREE"` means the finding should be discarded.
- `"reason"` is an optional short rationale.
