# Edit Guidelines

Use `merge.prompts.editGuidelines` to append repository-specific edit standards without replacing Magi's built-in task prompt.

```json
{
  "merge": {
    "prompts": {
      "editGuidelines": ".agents/references/edit-guidelines.md"
    }
  }
}
```

Magi loads the file and appends it in an `<edit_guidelines>` block before the fixed output contract for the editor phase. It is not added to reviewer or CI classification prompts.

Guideline files support the same placeholders as the prompt phase they are appended to.
