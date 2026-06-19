Return exactly one JSON object and nothing else. Do not wrap it in markdown.

```json
{
  "votes": [
    {
      "reviewer": "reviewer-key-that-authored-the-finding",
      "index": 0,
      "vote": "AGREE" | "DISAGREE",
      "comment": "Short rationale."
    }
  ]
}
```

Rules:

- `"votes"` must include one vote for every finding listed in the task.
- Do not vote on your own findings.
- `"reviewer"` is the reviewer key that authored the finding.
- `"index"` is the zero-based index of the finding in that reviewer's listed findings.
- `"vote"` must be `"AGREE"` or `"DISAGREE"`.
- `"AGREE"` means the finding should remain posted.
- `"DISAGREE"` means the finding should be discarded.
- `"comment"` is a short rationale for the vote.
