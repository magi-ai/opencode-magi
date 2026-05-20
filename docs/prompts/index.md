# Prompts

Magi keeps built-in task prompts as Markdown templates under [`src/prompts/templates`](/src/prompts/templates), grouped by config area. The plugin reads these files at runtime, replaces placeholders, wraps the result in `<task>`, then appends the fixed output contract from code.

Custom prompt files replace the built-in task template for that phase. They do not replace the fixed output contract, so prompt customization cannot change the required response schema.

Guideline files are additive. Configure `review.prompts.reviewGuidelines` or `merge.prompts.editGuidelines` when you want to keep Magi's built-in task prompts and append shared guidance from a Markdown file.

Custom prompt and guideline files are rendered with the same placeholder values as the built-in template for that phase.

Project prompt paths in `.opencode/magi.json` override the same global prompt key from `~/.config/opencode/magi.json` and inherit any other global prompt keys. Paths may be absolute, project-relative, or start with `~/`.

## Prompt Reference

Review prompts:

- [Review](review/review.md) - Initial PR review.
- [Re-review](review/rereview.md) - Re-review after edits or new commits.
- [Review Guidelines](review/review-guidelines.md) - Shared reviewer guidance.
- [CI Classification](review/ci-classification.md) - Failed check classification before review.
- [Finding Validation](review/finding-validation.md) - Finding-level majority validation.
- [Close Reconsideration](review/close-reconsideration.md) - Initial and re-review close reconsideration.

Merge prompts:

- [Edit](merge/edit.md) - Editor fixes, replies, and clarification requests.
- [Edit Guidelines](merge/edit-guidelines.md) - Shared editor guidance.
- [CI Classification](merge/ci-classification.md) - Failed check classification after editor changes.

Triage prompts:

- [Existing PR](triage/existing-pr.md) - Decide whether a related PR already handles an issue.
- [Duplicate](triage/duplicate.md) - Decide whether an issue duplicates another issue.
- [Kind](triage/kind.md) - Decide whether an issue is a bug, feature request, or needs more information.
- [Bug](triage/bug.md) - Decide whether a bug report is reproduced or otherwise valid.
- [Feature](triage/feature.md) - Decide whether a feature request should be implemented.
- [Comment Classification](triage/comment-classification.md) - Classify mention replies for reconsideration.

## Final Prompt Shape

For each model call, Magi builds one final prompt from several parts.

The `<task>` block comes from either Magi's built-in Markdown template or your configured `review.prompts.*`, `merge.prompts.*`, or `triage.prompts.*` Markdown file. It tells the model what phase it is running, what PR or issue to inspect, what diff range to use when relevant, and what inputs Magi has collected for that phase.

For example, in a review prompt:

- Without `review.prompts.review`, Magi uses the built-in [`review/review.md`](/src/prompts/templates/review/review.md) template.
- With `review.prompts.review`, Magi uses that file instead of the built-in template.
- In both cases, Magi still appends the fixed review output contract.

In a triage vote prompt, `triage.prompts.existingPr`, `triage.prompts.duplicate`, `triage.prompts.kind`, `triage.prompts.bug`, `triage.prompts.feature`, and `triage.prompts.commentClassification` replace their matching built-in triage task templates. Magi still appends the fixed output contract for that phase.

The custom file replaces the built-in task, but it does not replace the output schema.

The final prompt has this shape:

```text
<task>
...built-in template or configured prompt template, with runtime values filled in...
</task>

<language>
...optional language hint from config.language...
</language>

<persona>
...optional reviewer/editor/triage agent persona...
</persona>

<review_guidelines>
...optional Markdown loaded from review.prompts.reviewGuidelines...
</review_guidelines>

<edit_guidelines>
...optional Markdown loaded from merge.prompts.editGuidelines...
</edit_guidelines>

<output_contract>
...fixed JSON schema rules controlled by Magi...
</output_contract>
```

Only the task template and guideline files support placeholder replacement. The output contract is always fixed so prompt customization cannot change the required response shape.

## Repair

If model output does not match the required schema, Magi asks for a corrected JSON object with this repair prompt:

```text
Your previous {schemaName} output did not match the required schema. Return only a corrected JSON object. Do not include markdown or explanation. Previous output:

{previousOutput}
```
