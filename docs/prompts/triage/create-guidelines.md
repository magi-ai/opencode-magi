# Create Guidelines

Use `triage.prompts.createGuidelines` to append repository-specific implementation standards without replacing Magi's built-in PR creation task prompt.

```json
{
  "triage": {
    "prompts": {
      "createGuidelines": ".agents/references/create-guidelines.md"
    }
  }
}
```

Magi loads the file and appends it in a `<create_guidelines>` block before the fixed output contract for the PR creation phase. It is not added to triage voting, comment, or question prompts.

Guideline files support the same placeholders as the prompt phase they are appended to.
