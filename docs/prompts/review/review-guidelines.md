# Review Guidelines

Use `review.prompts.reviewGuidelines` to append repository-specific review standards without replacing Magi's built-in task prompt.

```json
{
  "review": {
    "prompts": {
      "reviewGuidelines": ".agents/references/pr-review-guidelines.md"
    }
  }
}
```

Magi loads the file and appends it in a `<review_guidelines>` block before the fixed output contract for these reviewer phases: initial review, re-review, finding validation, close reconsideration, and re-review close reconsideration. It is not added to editor or CI classification prompts.

Guideline files support the same placeholders as the prompt phase they are appended to.
