export const reviewOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE",
  "findings": [
    {
      "path": "relative/path.ext",
      "line": 123,
      "startLine": 120,
      "issue": "What is wrong.",
      "fix": "How to fix it.",
      "perspective": "Optional review perspective."
    }
  ],
  "reason": "Required only for CLOSE."
}

Rules:
- MERGE requires an empty findings array.
- CHANGES_REQUESTED requires at least one finding.
- CLOSE requires a reason and an empty findings array.
- path must be repository-relative.
- line is required and must target a valid right-side line inside the PR diff hunk.
- startLine is optional and must also target a valid right-side line inside the same PR diff hunk range.
- Omit startLine for single-line findings.
- Do not omit line. Do not create file-level or body-only findings.
- Missing closing-issue requirements must be normal findings anchored to the nearest responsible changed line.
- If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
</output_contract>`.trim()

export const rereviewOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE",
  "resolve": [{ "commentId": 123, "threadId": "..." }],
  "followUps": [{ "commentId": 123, "body": "..." }],
  "newFindings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }],
  "reason": "Required only for CLOSE."
}

Rules:
- MERGE requires empty followUps and newFindings arrays.
- CHANGES_REQUESTED requires at least one followUp or newFinding.
- CLOSE requires a reason and empty followUps and newFindings arrays.
- line is required and must target a valid right-side line inside the latest PR diff hunk.
- startLine is optional and must also target a valid right-side line inside the same latest PR diff hunk range.
- Omit startLine for single-line findings.
- Do not omit line. Do not create file-level or body-only findings.
- Missing closing-issue requirements must be normal newFindings anchored to the nearest responsible changed line.
- If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
</output_contract>`.trim()

export const findingValidationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
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

Rules:
- Vote on every finding listed in the task.
- Do not vote on your own findings.
- AGREE means the finding should remain posted.
- DISAGREE means the finding should be discarded.
</output_contract>`.trim()

export const closeReconsiderationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "verdict": "MERGE" | "CHANGES_REQUESTED",
  "findings": [
    {
      "path": "relative/path.ext",
      "line": 123,
      "startLine": 120,
      "issue": "What is wrong.",
      "fix": "How to fix it."
    }
  ]
}

Rules:
- MERGE requires an empty findings array.
- CHANGES_REQUESTED requires at least one finding.
- CLOSE is not allowed in this reconsideration step.
- line is required and must target a valid right-side line inside the PR diff hunk.
- startLine is optional and must also target a valid right-side line inside the same PR diff hunk range.
- Do not omit line. Do not create file-level or body-only findings.
</output_contract>`.trim()

export const rereviewCloseReconsiderationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "verdict": "MERGE" | "CHANGES_REQUESTED",
  "resolve": [{ "commentId": 123, "threadId": "..." }],
  "followUps": [{ "commentId": 123, "body": "..." }],
  "newFindings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }]
}

Rules:
- MERGE requires empty followUps and newFindings arrays.
- CHANGES_REQUESTED requires at least one followUp or newFinding.
- CLOSE is not allowed in this reconsideration step.
- line is required and must target a valid right-side line inside the latest PR diff hunk.
- startLine is optional and must also target a valid right-side line inside the same latest PR diff hunk range.
- Do not omit line. Do not create file-level or body-only findings.
</output_contract>`.trim()

export const editOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "mode": "EDITED" | "REPLIED",
  "commitSha": "full sha, required only when mode is EDITED; omit when mode is REPLIED",
  "commitMessage": "fix(scope): short description, required only when mode is EDITED; omit when mode is REPLIED",
  "filesTouched": ["relative/path.ext"],
  "responses": [{ "commentId": 123, "action": "FIXED" | "DISAGREE" | "ASK", "body": "Fixed." }]
}

Rules:
- Use EDITED only when you edited files, staged changes, and committed.
- Use REPLIED when you only replied without code changes.
- FIXED means you agreed with the reviewer and made a code change.
- DISAGREE means you did not edit because the requested change is incorrect or unnecessary.
- ASK means you did not edit because you need clarification.
- Do not make changes just because a reviewer requested them; edit only when you understand and agree.
- Do not push. The orchestrator pushes after validating this envelope.
- filesTouched must include every final changed file.
- responses must include a reply for each thread you addressed.
- REPLIED requires filesTouched to be empty and at least one DISAGREE or ASK response.
</output_contract>`.trim()

export const triageCreatePrOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "mode": "EDITED" | "REPLIED",
  "commitSha": "full sha, required only when mode is EDITED; omit when mode is REPLIED",
  "commitMessage": "fix(scope): short description, required only when mode is EDITED; omit when mode is REPLIED",
  "filesTouched": ["relative/path.ext"],
  "pullRequest": {
    "title": "PR title, required only when mode is EDITED; omit when mode is REPLIED",
    "body": "PR body, required only when mode is EDITED; omit when mode is REPLIED"
  },
  "responses": [{ "commentId": 123, "action": "FIXED" | "DISAGREE" | "ASK", "body": "Fixed." }]
}

Rules:
- Use EDITED only when you edited files, staged changes, and committed.
- Use REPLIED when you only replied without code changes.
- For EDITED, pullRequest.title and pullRequest.body must be non-empty and follow the repository's PR conventions.
- Do not push or create the PR. The orchestrator pushes and creates the PR using pullRequest exactly as provided.
- filesTouched must include every final changed file.
- responses may be empty when no review threads were addressed.
- REPLIED requires filesTouched to be empty and at least one DISAGREE or ASK response.
</output_contract>`.trim()

export const ciClassificationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.
{
  "checks": [
    {
      "name": "exact failed check name",
      "classification": "SCOPE_IN" | "SCOPE_OUT",
      "reason": "Short reason."
    }
  ]
}
Rules:
- Return one item for every failed check.
- SCOPE_IN means the failure should be treated as caused by the PR changes and passed to reviewers/editor.
- SCOPE_OUT means the failure is likely flaky, external, or infrastructure-related and may be rerun.
- If uncertain, choose SCOPE_IN.
</output_contract>`.trim()

export const ciClassificationAfterEditOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.
{
  "checks": [
    {
      "name": "exact failed check name",
      "classification": "SCOPE_IN" | "SCOPE_OUT",
      "reason": "Short reason."
    }
  ]
}
Rules:
- Return one item for every failed check.
- SCOPE_IN means the failure should be treated as caused by the PR changes or the editor changes and passed to reviewers/editor.
- SCOPE_OUT means the failure is likely flaky, external, or infrastructure-related and may be rerun.
- If uncertain, choose SCOPE_IN.
</output_contract>`.trim()

export function triageVoteOutputContract(votes: string): string {
  return `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "vote": ${votes},
  "reason": "Short rationale.",
  "body": "Required only when vote is ASK. Public issue comment body asking for the missing information."
}

Rules:
- body is required when vote is ASK and must be written for the issue author.
- Omit body when vote is not ASK.
</output_contract>`.trim()
}

export const triageDuplicateOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "vote": "DUPLICATE" | "NOT_DUPLICATE",
  "duplicateOf": 123,
  "reason": "Short rationale."
}

Rules:
- duplicateOf is required only when vote is DUPLICATE.
- duplicateOf must be one of the provided duplicate candidate issue numbers.
</output_contract>`.trim()

export const triageCommentClassificationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "comments": [
    {
      "commentId": 123,
      "classification": "OBJECTION" | "NEW_EVIDENCE" | "CLARIFICATION" | "ACKNOWLEDGEMENT" | "UNRELATED",
      "reason": "Short rationale."
    }
  ]
}
</output_contract>`.trim()

export const triageActionOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "action": "ASK" | "COMMENT" | "CLOSE" | "PR" | "CLEAR_ONLY",
  "reason": "Short rationale."
}

Rules:
- Choose only an action listed as allowed in the task context.
- ASK means post an author-mentioned question and do not close, create a PR, or clear labels.
- COMMENT means post a decision comment only.
- CLOSE means post a decision comment and close the issue.
- PR means post a decision comment and create an implementation PR.
- CLEAR_ONLY means clear labels without posting a comment.
</output_contract>`.trim()

const outputContractsBySchemaName: Record<string, string> = {
  "CI classification": ciClassificationOutputContract,
  "close reconsideration": closeReconsiderationOutputContract,
  edit: editOutputContract,
  "finding validation": findingValidationOutputContract,
  rereview: rereviewOutputContract,
  "rereview close reconsideration": rereviewCloseReconsiderationOutputContract,
  review: reviewOutputContract,
  "triage action": triageActionOutputContract,
  "triage acceptance": triageVoteOutputContract('"YES" | "NO" | "ASK"'),
  "triage category": triageVoteOutputContract(
    '"ASK" or one of the configured category IDs',
  ),
  "triage create PR": triageCreatePrOutputContract,
  "triage comment classification": triageCommentClassificationOutputContract,
  "triage duplicate": triageDuplicateOutputContract,
  "triage existing PR": triageVoteOutputContract(
    '"RELATED_PR_HANDLES_ISSUE" | "RELATED_PR_DOES_NOT_HANDLE_ISSUE"',
  ),
  "triage reconsider": triageVoteOutputContract('"YES" | "NO" | "ASK"'),
}

export function repairPrompt(schemaName: string): string {
  const outputContract = outputContractsBySchemaName[schemaName]
  const instructions = `Your previous ${schemaName} output did not match the required schema. Regenerate the ${schemaName} result.\n\nReturn only a JSON object matching the output contract below. Do not include analysis, explanation, apologies, markdown, or any text before or after the JSON object.`

  if (!outputContract) return instructions

  return `${instructions}\n\n${outputContract}`
}
