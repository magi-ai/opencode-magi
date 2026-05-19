# Prompts

Magi keeps built-in task prompts as Markdown templates under [`src/prompts/templates`](/src/prompts/templates). The plugin reads these files at runtime, replaces placeholders, wraps the result in `<task>`, then appends the fixed output contract from code.

Custom prompt files replace the built-in task template for that phase. They do not replace the fixed output contract, so prompt customization cannot change the required response schema.

Guideline files are additive. Configure `review.prompts.reviewGuidelines` or `merge.prompts.editGuidelines` when you want to keep Magi's built-in task prompts and append shared guidance from a Markdown file.

Custom prompt and guideline files are also rendered with the same placeholder values as the built-in template for that phase.

Project prompt paths in `.opencode/magi.json` override the same global prompt key from `~/.config/opencode/magi.json` and inherit any other global prompt keys.

## Final Prompt Shape

For each model call, Magi builds one final prompt from several parts.

The `<task>` block comes from either Magi's built-in Markdown template or your configured `review.prompts.*` or `merge.prompts.*` Markdown file. It tells the model what phase it is running, what PR to inspect, what diff range to use, and what inputs Magi has collected for that phase.

For example, in a review prompt:

- Without `review.prompts.review`, Magi uses [`review.md`](/src/prompts/templates/review.md).
- With `review.prompts.review`, Magi uses that file instead of [`review.md`](/src/prompts/templates/review.md).
- In both cases, Magi still appends the fixed review output contract.

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
...optional reviewer/editor persona...
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

## Review Guidelines

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

Paths may be absolute, project-relative, or start with `~/`.

## Placeholder Rendering

Placeholders use `{name}` syntax. Unknown placeholders are left unchanged.

### Review

Used when a reviewer performs an initial PR review.

Config key: `review.prompts.review`

Built-in template: [`review.md`](/src/prompts/templates/review.md)

| Placeholder                 | Meaning                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `{pr}`                      | Pull request number.                                                    |
| `{owner}` / `{repo}`        | GitHub repository owner and name.                                       |
| `{worktreePath}`            | Temporary PR worktree path.                                             |
| `{baseSha}` / `{headSha}`   | Diff range for the review.                                              |
| `{jsonEncodedWorktreePath}` | JSON-encoded worktree path for shell snippets.                          |
| `{ciFailureContext}`        | Scope-in CI failure context, when present.                              |
| `{ciFailureContextBlock}`   | Full `<ci_failure_context>` block when context exists, otherwise empty. |

### Re-review

Used when a reviewer checks new commits or editor changes against unresolved review threads.

Config key: `review.prompts.rereview`

Built-in template: [`rereview.md`](/src/prompts/templates/rereview.md)

| Placeholder                       | Meaning                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `{pr}`                            | Pull request number.                                                                  |
| `{owner}` / `{repo}`              | GitHub repository owner and name.                                                     |
| `{worktreePath}`                  | Temporary PR worktree path.                                                           |
| `{previousHeadSha}` / `{headSha}` | Diff range for the re-review.                                                         |
| `{jsonEncodedWorktreePath}`       | JSON-encoded worktree path for shell snippets.                                        |
| `{unresolvedThreads}`             | JSON list of unresolved review threads for the reviewer.                              |
| `{ciFailureContext}`              | Scope-in CI failure context, when present.                                            |
| `{ciFailureContextBlock}`         | Full `<ci_failure_context>` block when context exists, otherwise empty.               |
| `{previousReview}`                | Previous GitHub review metadata, when available.                                      |
| `{previousReviewBlock}`           | Full `<previous_review>` block when previous review metadata exists, otherwise empty. |

### Edit

Used when the editor responds to requested changes by fixing code, disagreeing with a clear reason, or asking for clarification.

Config key: `merge.prompts.edit`

Built-in template: [`edit.md`](/src/prompts/templates/edit.md)

| Placeholder           | Meaning                                 |
| --------------------- | --------------------------------------- |
| `{pr}`                | Pull request number.                    |
| `{owner}` / `{repo}`  | GitHub repository owner and name.       |
| `{worktreePath}`      | Temporary PR worktree path.             |
| `{unresolvedThreads}` | JSON list of unresolved review threads. |

#### Edit Guidelines

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

Paths may be absolute, project-relative, or start with `~/`.

### Finding Validation

Used when reviewers vote on whether another reviewer's findings should remain posted.

Config key: `review.prompts.findingValidation`

Built-in template: [`finding-validation.md`](/src/prompts/templates/finding-validation.md)

| Placeholder                 | Meaning                                        |
| --------------------------- | ---------------------------------------------- |
| `{pr}`                      | Pull request number.                           |
| `{owner}` / `{repo}`        | GitHub repository owner and name.              |
| `{worktreePath}`            | Temporary PR worktree path.                    |
| `{baseSha}` / `{headSha}`   | Diff range for validating findings.            |
| `{jsonEncodedWorktreePath}` | JSON-encoded worktree path for shell snippets. |
| `{findings}`                | JSON list of findings to vote on.              |

### Close Reconsideration

Used when a reviewer returned `CLOSE`, but `CLOSE` did not reach majority. The reviewer must choose `MERGE` or `CHANGES_REQUESTED` before anything is posted.

Config key: `review.prompts.closeReconsideration`

Built-in template: [`close-reconsideration.md`](/src/prompts/templates/close-reconsideration.md)

| Placeholder                 | Meaning                                        |
| --------------------------- | ---------------------------------------------- |
| `{pr}`                      | Pull request number.                           |
| `{owner}` / `{repo}`        | GitHub repository owner and name.              |
| `{worktreePath}`            | Temporary PR worktree path.                    |
| `{baseSha}` / `{headSha}`   | Diff range for reconsideration.                |
| `{jsonEncodedWorktreePath}` | JSON-encoded worktree path for shell snippets. |
| `{closeReason}`             | The original minority close reason.            |

### Re-review Close Reconsideration

Used when a reviewer returned `CLOSE` during re-review, but `CLOSE` did not reach majority. The reviewer must choose `MERGE` or `CHANGES_REQUESTED` before anything is posted.

Config key: `review.prompts.closeReconsideration`

Built-in template: [`rereview-close-reconsideration.md`](/src/prompts/templates/rereview-close-reconsideration.md)

| Placeholder                       | Meaning                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `{pr}`                            | Pull request number.                                                    |
| `{owner}` / `{repo}`              | GitHub repository owner and name.                                       |
| `{worktreePath}`                  | Temporary PR worktree path.                                             |
| `{previousHeadSha}` / `{headSha}` | Diff range for reconsideration.                                         |
| `{jsonEncodedWorktreePath}`       | JSON-encoded worktree path for shell snippets.                          |
| `{unresolvedThreads}`             | JSON list of unresolved review threads for the reviewer.                |
| `{ciFailureContext}`              | Scope-in CI failure context, when present.                              |
| `{ciFailureContextBlock}`         | Full `<ci_failure_context>` block when context exists, otherwise empty. |
| `{closeReason}`                   | The original minority close reason.                                     |

### CI Classification

Used when failed checks need to be classified as caused by the PR (`SCOPE_IN`) or likely flaky, external, or infrastructure-related (`SCOPE_OUT`).

Config key: `review.prompts.ciClassification`

Built-in template: [`ci-classification.md`](/src/prompts/templates/ci-classification.md)

| Placeholder          | Meaning                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `{pr}`               | Pull request number.                                                                                  |
| `{owner}` / `{repo}` | GitHub repository owner and name.                                                                     |
| `{failedChecks}`     | JSON list of failed checks with `name`, `workflow`, `state`, `link`, and structured failure evidence. |

### CI Classification After Edit

Used when failed checks need to be classified after the editor has pushed fixes.

Config key: `merge.prompts.ciClassification`

Built-in template: [`ci-classification-after-edit.md`](/src/prompts/templates/ci-classification-after-edit.md)

| Placeholder                       | Meaning                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `{pr}`                            | Pull request number.                                                                                  |
| `{owner}` / `{repo}`              | GitHub repository owner and name.                                                                     |
| `{cycle}`                         | Edit cycle number.                                                                                    |
| `{previousHeadSha}` / `{headSha}` | Diff range for the editor changes.                                                                    |
| `{worktreePath}`                  | Temporary PR worktree path.                                                                           |
| `{jsonEncodedWorktreePath}`       | JSON-encoded worktree path for shell snippets.                                                        |
| `{failedChecks}`                  | JSON list of failed checks with `name`, `workflow`, `state`, `link`, and structured failure evidence. |

## Repair

If model output does not match the required schema, Magi asks for a corrected JSON object with this repair prompt:

```text
Your previous {schemaName} output did not match the required schema. Return only a corrected JSON object. Do not include markdown or explanation. Previous output:

{previousOutput}
```
